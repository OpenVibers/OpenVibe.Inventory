'use strict';
/**
 * Grantors (ADR-054 §3 amendment, Contracts 0.123.0): Live, the issuer of its hats and effects, lets OpenVibe.Quest
 * grant six of them as quest rewards (server/data/live-grantors.json, set at boot). Quest grants those (earned,
 * idempotent per its own key, recorded with Quest as the actor, the event naming Live as the issuer) and nothing else;
 * it cannot edit, revoke or re-list them; Live sets and clears the list; a bad list is refused; a second boot writes
 * nothing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const api = (path, o = {}) => t.get(`/api/v1${path}`, o);
    const LIVE = t.network.serviceToken('live', ['inventory.item.read', 'inventory.item.grant', 'inventory.item.consume', 'inventory.definition.manage']);
    const QUEST = t.network.serviceToken('quest', ['inventory.item.grant', 'inventory.item.consume', 'inventory.definition.manage']);
    const A = 'usr_01JZ0000000000000000000AAA';
    const inv = t.ctx.inv;
    try {
        await check('the boot seed names Quest on its six reward items and Games on its six, and only those', async () => {
            const live = (await inv.listDefinitions({ issuer: 'service:live', limit: 500 }));
            const by = (who) => live.filter((d) => JSON.stringify(d.grantors || []) === JSON.stringify([who])).map((d) => d.aliases[0]).sort();
            assert.deepStrictEqual(by('service:quest'), ['fx_fire', 'fx_ice', 'fx_rainbow', 'hat_basic_cap', 'px_hearts', 'px_sparkle']);
            assert.deepStrictEqual(by('service:games'), ['fx_golden', 'fx_neon', 'fx_toxic', 'hat_cowboy', 'px_flames', 'px_stars']);
            assert.strictEqual(live.filter((d) => (d.grantors || []).length).length, 12, 'no other item names a grantor');
            const named = by('service:quest');
            const r = await api(`/definitions/${named.length && (await inv.byAlias('service:live', 'px_sparkle')).id}`);
            assert.deepStrictEqual(r.json().definition.grantors, ['service:quest'], 'the public definition says who may grant it');
            const page = await t.get(`/items/${(await inv.byAlias('service:live', 'px_sparkle')).id}`);
            assert.ok(page.text.includes('How to get it') && page.text.includes('https://openvibe.quest/'), 'its page says where to earn it');
            const golden = await t.get(`/items/${(await inv.byAlias('service:live', 'fx_golden')).id}`);
            assert.ok(golden.text.includes('How to get it') && golden.text.includes('https://openvibe.games/'), 'a Games reward says where');
            assert.ok(golden.text.includes('Big Haul in Scraplandia'), 'and which achievement');
            const cap = await t.get(`/items/${(await inv.byAlias('service:live', 'hat_crown')).id}`);
            assert.ok(!cap.text.includes('How to get it'), 'an item nobody else gives has no such section');
            assert.ok(cap.text.includes('Only its issuer can give this item'));
            // Each item page describes itself: name, rarity and kind, how many own it, how it is got (≤ 160 characters).
            const descOf = (html) => ((html.match(/<meta name="description" content="([^"]*)">/) || [])[1] || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
            assert.match(descOf(page.text), /^.+, an? (common|uncommon|rare|epic|legendary) .+ on OpenVibe[.: ].* (Owned by \d+ (person|people)|\d+ of \d+ given)\. Earned on OpenVibe\.Quest\.$/);
            assert.match(descOf(golden.text), /Earned on OpenVibe\.Games\.$/);
            assert.match(descOf(cap.text), /Given by its issuer, never sold\.$|…$/);
            for (const html of [page.text, golden.text, cap.text]) assert.ok(descOf(html).length <= 160, descOf(html));
            const again = await require('../server/inventory/seed').seed(inv, { log: { log() {} } });
            assert.strictEqual(again.grantors, 0, 'a second boot changes nothing');
        });

        await check('Quest grants a reward: earned, idempotent per its key, Quest the actor, Live the issuer', async () => {
            const sparkle = await inv.byAlias('service:live', 'px_sparkle');
            const g = await api('/grants', { bearer: QUEST, json: { definition_id: sparkle.id, subject: A, idempotency_key: 'quest:say-hello-in-chat:1', origin: 'earned', reason: 'Quest: Say hello in chat' } });
            assert.strictEqual(g.status, 201, g.text);
            assert.deepStrictEqual([g.json().instance.origin, g.json().instance.owner], ['earned', A]);
            const twice = await api('/grants', { bearer: QUEST, json: { definition_id: sparkle.id, subject: A, idempotency_key: 'quest:say-hello-in-chat:1', origin: 'earned' } });
            assert.deepStrictEqual([twice.status, twice.json().instance.id], [200, g.json().instance.id], 'the same key answers the same instance');
            const row = await t.ctx.s.db.maybe("SELECT actor, detail FROM inventory_ledger WHERE instance_id = $1 AND action = 'earned'", [g.json().instance.id]);
            assert.strictEqual(row.actor, 'service:quest');
            const ev = (await t.ctx.s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope).filter((e) => e.event_type === 'inventory.item.granted').pop();
            assert.strictEqual(ev.payload.issuer, 'service:live', 'the event names the item\'s issuer');
            assert.match(JSON.stringify(ev.actor), /quest/, 'and Quest as its actor');
        });

        await check('a grantor only grants: no other item, no edit, no revoke', async () => {
            const golden = await inv.byAlias('service:live', 'fx_golden');
            const other = await api('/grants', { bearer: QUEST, json: { definition_id: golden.id, subject: A, idempotency_key: 'quest:other:0001' } });
            assert.deepStrictEqual([other.status, other.json().code], [403, 'inventory.not_issuer']);
            const sparkle = await inv.byAlias('service:live', 'px_sparkle');
            const edit = await api(`/definitions/${sparkle.id}`, { bearer: QUEST, method: 'PATCH', json: { grantors: ['service:quest', 'service:games'] } });
            assert.deepStrictEqual([edit.status, edit.json().code], [403, 'inventory.not_issuer'], 'only the issuer changes the list');
            const owned = (await inv.inventory(A, { own: true })).instances.find((i) => i.definition_id === sparkle.id);
            const revoke = await api(`/instances/${owned.id}/revoke`, { bearer: QUEST, method: 'POST', json: { reason: 'no' } });
            assert.strictEqual(revoke.status, 403, 'revoking stays the issuer\'s');
        });

        await check('Live sets and clears the list; a bad list is refused', async () => {
            const cap = await inv.byAlias('service:live', 'hat_basic_cap');
            const bad = await api(`/definitions/${cap.id}`, { bearer: LIVE, method: 'PATCH', json: { grantors: ['user:usr_01JZ0000000000000000000AAA'] } });
            assert.deepStrictEqual([bad.status, bad.json().code], [422, 'inventory.bad_grantors'], 'a person is never a grantor');
            const dup = await api(`/definitions/${cap.id}`, { bearer: LIVE, method: 'PATCH', json: { grantors: ['service:quest', 'service:quest'] } });
            assert.strictEqual(dup.status, 422);
            const cleared = await api(`/definitions/${cap.id}`, { bearer: LIVE, method: 'PATCH', json: { grantors: [] } });
            assert.strictEqual(cleared.status, 200, cleared.text);
            assert.strictEqual(cleared.json().definition.grantors, undefined);
            const refused = await api('/grants', { bearer: QUEST, json: { definition_id: cap.id, subject: A, idempotency_key: 'quest:go-live:0001', origin: 'earned' } });
            assert.strictEqual(refused.status, 403, 'cleared: Quest no longer grants it');
        });
    } finally {
        await t.close();
    }
    done();
})();
