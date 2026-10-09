'use strict';
/**
 * The inventory (ADR-054) through its API: Live's kinds and cosmetics are seeded at boot; an issuer grants within its
 * own namespace only, idempotently and within a supply cap; a person sees and equips what they own; the public reads
 * show owned items of published definitions; a batch of equipped sets is one call; every movement writes a ledger row
 * and an event; and nothing anywhere sells, buys, trades or converts an item.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const LIVE = t.network.serviceToken('live', ['inventory.item.read', 'inventory.item.grant', 'inventory.item.consume', 'inventory.definition.manage', 'inventory.item.list', 'inventory.equip.manage']);
    const QUEST = t.network.serviceToken('quest', ['inventory.item.grant', 'inventory.definition.manage']);
    const NOREAD = t.network.serviceToken('search', []);
    const api = (path, o = {}) => t.get(`/api/v1${path}`, o);
    const valid = (id, body) => { const v = contracts.validate(id, body); assert.ok(v.valid, `${id}: ${JSON.stringify(v.errors)}`); };
    const events = async (type) => (await t.ctx.s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope).filter((e) => e.event_type === type);
    let rainbow;
    let crown;
    let granted;

    try {
        await check('boot registers Live\'s five kinds and 70 cosmetics, published, found by Live\'s ids', async () => {
            const kinds = (await api('/kinds')).json().kinds;
            assert.deepStrictEqual(kinds.map((k) => k.id), ['live.chat_tag', 'live.hat', 'live.name_effect', 'live.particle', 'live.voice']);
            for (const k of kinds) valid('inventory.kind@1', k);
            const defs = (await api('/definitions?limit=500')).json().definitions;
            assert.strictEqual(defs.length, 70);
            for (const d of defs) valid('inventory.definition@1', d);
            rainbow = defs.find((d) => (d.aliases || []).includes('fx_rainbow'));
            crown = defs.find((d) => (d.aliases || []).includes('hat_crown'));
            assert.deepStrictEqual([rainbow.kind, rainbow.rarity, rainbow.art.token, rainbow.issuer], ['live.name_effect', 'common', 'name-fx-rainbow', 'service:live']);
            assert.strictEqual(crown.rarity, 'epic');
            // A second boot on the same database seeds nothing again.
            const { seed } = require('../server/inventory/seed');
            assert.deepStrictEqual(await seed(t.ctx.inv, { log: { log() {} } }), { kinds: 5, definitions: 0, grantors: 0 });
        });

        await check('an issuer grants within its namespace, idempotently; a non-stackable item already owned answers the one held', async () => {
            const g = await api('/grants', { bearer: LIVE, json: { definition_id: rainbow.id, subject: alice.subject, idempotency_key: 'grant-0000-0001', reason: 'test' } });
            assert.strictEqual(g.status, 201, g.text);
            granted = g.json().instance;
            valid('inventory.instance@1', granted);
            assert.deepStrictEqual([granted.owner, granted.origin, granted.state], [alice.subject, 'granted', 'owned']);
            const again = await api('/grants', { bearer: LIVE, json: { definition_id: rainbow.id, subject: alice.subject, idempotency_key: 'grant-0000-0001' } });
            assert.deepStrictEqual([again.status, again.json().instance.id, again.json().created], [200, granted.id, false]);
            const other = await api('/grants', { bearer: LIVE, json: { definition_id: rainbow.id, subject: alice.subject, idempotency_key: 'grant-0000-0002' } });
            assert.deepStrictEqual([other.status, other.json().instance.id], [200, granted.id], 'not stackable: the one she has');
            assert.strictEqual((await events('inventory.item.granted')).length, 1);
            const ev = (await events('inventory.item.granted'))[0];
            valid('inventory.item.granted', ev.payload);
            assert.deepStrictEqual([ev.subject, ev.visibility], [{ type: 'user', id: alice.subject }, 'subject']);
        });

        await check('only the kind\'s issuer defines or grants its items; people and missing capabilities are refused', async () => {
            // Golden Name names no grantors (Rainbow does: Quest gives it, test/grantors.test.js).
            const golden = await t.ctx.inv.byAlias('service:live', 'fx_golden');
            const wrong = await api('/grants', { bearer: QUEST, json: { definition_id: golden.id, subject: bob.subject, idempotency_key: 'quest-0000-0001' } });
            assert.deepStrictEqual([wrong.status, wrong.json().code], [403, 'inventory.not_issuer']);
            const def = await api('/definitions', { bearer: QUEST, json: { kind: 'live.hat', name: 'Quest hat', art: { emoji: '🎩' }, rarity: 'rare', attributes: { tier: 3 } } });
            assert.deepStrictEqual([def.status, def.json().code], [403, 'inventory.not_issuer']);
            const person = await api('/grants', { as: alice, method: 'POST', json: { definition_id: rainbow.id, subject: alice.subject, idempotency_key: 'self-0000-0001' }, headers: { origin: t.base } });
            assert.deepStrictEqual([person.status, person.json().code], [403, 'inventory.not_issuer'], 'a person is not an issuer');
            const noCap = await api('/grants', { bearer: NOREAD, json: { definition_id: rainbow.id, subject: bob.subject, idempotency_key: 'none-0000-0001' } });
            assert.strictEqual(noCap.status, 403);
            const bought = await api('/grants', { bearer: LIVE, json: { definition_id: rainbow.id, subject: bob.subject, idempotency_key: 'buy-0000-0001', origin: 'bought' } });
            assert.deepStrictEqual([bought.status, bought.json().code], [422, 'inventory.bad_origin'], 'nothing is bought (ADR-054 §5)');
        });

        await check('a capped item numbers its instances and stops at the cap; attributes must fit the kind', async () => {
            const bad = await api('/definitions', { bearer: LIVE, json: { kind: 'live.hat', name: 'Broken', art: { emoji: '🎩' }, rarity: 'rare', attributes: { tier: 99 } } });
            assert.deepStrictEqual([bad.status, bad.json().code], [422, 'inventory.bad_attributes']);
            const made = await api('/definitions', { bearer: LIVE, json: { kind: 'live.hat', name: 'Launch Cap', art: { emoji: '🧢' }, rarity: 'legendary', attributes: { tier: 6, hat_char: '🧢' }, supply_cap: 2, publish: true, aliases: ['hat_launch_cap'] } });
            assert.strictEqual(made.status, 201, made.text);
            const capId = made.json().definition.id;
            assert.strictEqual((await events('inventory.definition.published')).filter((e) => e.payload.definition_id === capId).length, 1);
            const a = await api('/grants', { bearer: LIVE, json: { definition_id: capId, subject: alice.subject, idempotency_key: 'cap-0000-0001' } });
            const b = await api('/grants', { bearer: LIVE, json: { definition_id: capId, subject: bob.subject, idempotency_key: 'cap-0000-0002' } });
            assert.deepStrictEqual([a.json().instance.serial, b.json().instance.serial], [1, 2]);
            const c = await api('/grants', { bearer: LIVE, json: { definition_id: capId, subject: t.network.addUser('carol').subject, idempotency_key: 'cap-0000-0003' } });
            assert.deepStrictEqual([c.status, c.json().code], [409, 'inventory.supply_exhausted']);
            const locked = await api(`/definitions/${capId}`, { bearer: LIVE, method: 'PATCH', json: { rarity: 'common' } });
            assert.deepStrictEqual([locked.status, locked.json().code], [409, 'inventory.published'], 'rarity is fixed once people own it');
        });

        await check('a person equips what they own, one item per slot; a batch read is one call', async () => {
            const eq = await api('/me/equipped', { as: alice, method: 'PUT', json: { kind: 'live.name_effect', slot: 'name_effect', instance_id: granted.id }, headers: { origin: t.base } });
            assert.strictEqual(eq.status, 200, eq.text);
            valid('inventory.equipped@1', eq.json());
            assert.strictEqual(eq.json().slots['live.name_effect:name_effect'].token, 'name-fx-rainbow');
            const notMine = await api('/me/equipped', { as: bob, method: 'PUT', json: { kind: 'live.name_effect', slot: 'name_effect', instance_id: granted.id }, headers: { origin: t.base } });
            assert.deepStrictEqual([notMine.status, notMine.json().code], [409, 'inventory.not_owned']);
            const wrongSlot = await api('/me/equipped', { as: alice, method: 'PUT', json: { kind: 'live.name_effect', slot: 'hat', instance_id: granted.id }, headers: { origin: t.base } });
            assert.deepStrictEqual([wrongSlot.status, wrongSlot.json().code], [422, 'inventory.bad_slot']);
            const crossSite = await api('/me/equipped', { as: alice, method: 'PUT', json: { kind: 'live.name_effect', slot: 'name_effect', instance_id: null }, headers: { origin: 'https://evil.example' } });
            assert.strictEqual(crossSite.status, 403, 'a cookie write from another site is refused');
            const batch = await api(`/equipped?subjects=${alice.subject},${bob.subject}`);
            valid('inventory.equipped-batch@1', batch.json());
            assert.deepStrictEqual(batch.json().equipped.map((e) => Object.keys(e.slots).length), [1, 0]);
            const forLive = await api('/me/equipped', { bearer: LIVE, method: 'PUT', json: { kind: 'live.name_effect', slot: 'name_effect', instance_id: null }, headers: { 'X-OV-Subject': alice.subject } });
            assert.deepStrictEqual([forLive.status, Object.keys(forLive.json().slots).length], [200, 0], 'Live clears the slot acting for her');
            assert.strictEqual((await events('inventory.item.unequipped')).length, 1);
        });

        await check('the public inventory shows owned items; the person\'s own read shows every state; consume and revoke', async () => {
            const pub = await api(`/people/${alice.subject}/items`);
            valid('inventory.inventory@1', pub.json());
            assert.strictEqual(pub.json().instances.length, 2);
            const used = await api(`/instances/${granted.id}/consume`, { bearer: LIVE, method: 'POST', json: {} });
            assert.strictEqual(used.json().instance.state, 'consumed');
            assert.strictEqual((await api(`/people/${alice.subject}/items`)).json().instances.length, 1, 'used up: off the public page');
            const own = await api('/me/items', { as: alice });
            assert.deepStrictEqual(own.json().instances.map((i) => i.state).sort(), ['consumed', 'owned']);
            const twice = await api(`/instances/${granted.id}/revoke`, { bearer: LIVE, method: 'POST', json: { reason: 'x' } });
            assert.deepStrictEqual([twice.status, twice.json().code], [409, 'inventory.not_owned']);
            const notIssuer = await api(`/instances/${granted.id}/consume`, { bearer: QUEST, method: 'POST', json: {} });
            assert.strictEqual(notIssuer.status, 403);
            const ledger = await t.ctx.s.db.many('SELECT action FROM inventory_ledger WHERE instance_id = $1 ORDER BY id', [granted.id]);
            assert.deepStrictEqual(ledger.map((r) => r.action), ['granted', 'equipped', 'unequipped', 'consumed']);
        });

        await check('a presented token must hold inventory.item.read; anyone reads without one', async () => {
            assert.strictEqual((await api('/kinds')).status, 200);
            assert.strictEqual((await api('/kinds', { bearer: NOREAD })).status, 403);
            assert.strictEqual((await api('/kinds', { bearer: LIVE })).status, 200);
        });

        await check('no route sells, buys, trades or converts an item (ADR-054 §5)', async () => {
            const fs = require('fs');
            const routes = fs.readFileSync(require.resolve('../server/http/api.js'), 'utf8') + fs.readFileSync(require.resolve('../server/http/pages.js'), 'utf8');
            for (const word of ['/buy', '/sell', '/trade', '/market', '/price', '/convert', '/cashout', '/case', '/drop']) assert.ok(!routes.includes(`'${word}`) && !routes.includes(`"${word}`), `no ${word} route`);
            for (const word of ['buy', 'sell', 'trade', 'market']) assert.strictEqual((await api(`/${word}`, { method: 'POST', json: {} })).status, 404, `POST /api/v1/${word} does not exist`);
            assert.ok(!/price|amount|vibes|coins/i.test(fs.readFileSync(require.resolve('../migrations/0001_initial.sql'), 'utf8').replace(/--.*$/gm, '')), 'no money column');
        });
    } finally {
        await t.close();
    }
    done();
})();
