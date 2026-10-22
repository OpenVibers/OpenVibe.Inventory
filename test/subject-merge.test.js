'use strict';
/**
 * ADR-029 / ADR-054 §7: network.subject.merged folds one account's items into the survivor's, through the signed
 * loopback route POST /internal/events. Every instance moves; where both own the same non-stackable item the oldest is
 * kept and the other is revoked; the survivor's equipped set wins; the ledger keeps the folded account's rows and gains
 * one `merged` row per instance; a redelivery (same merge_id) moves nothing.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `whsec_${'fixture'.repeat(6)}`;
const MERGE = 'mrg_01JZ0000000000000000000MRG';

(async () => {
    const t = await boot({ env: { INVENTORY_EVENTS_SECRET: SECRET } });
    const keep = t.network.addUser('keep');
    const gone = t.network.addUser('gone');
    const bob = t.network.addUser('bob');
    const db = t.ctx.s.db;
    const inv = t.ctx.inv;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const merged = (id, payload = {}, source = 'network') => ({ event_id: id, event_type: 'network.subject.merged', source, version: 1, timestamp: new Date().toISOString(),
        payload: { merge_id: MERGE, from: gone.subject, into: keep.subject, merged_at: new Date().toISOString(), initiated_by: 'person', ...payload } });
    const own = async (who, alias, key, acquiredAt) => {
        const def = await inv.byAlias('service:live', alias);
        const r = await inv.grant('service:live', { definition_id: def.id, subject: who.subject, idempotency_key: `test-merge-${key}` });
        await db.exec('UPDATE inventory_instances SET acquired_at = $2 WHERE id = $1', [r.instance.id, acquiredAt]);
        return r.instance.id;
    };
    let goneCrown, keepCrown, goneFire, bobCrown, goneLedger;

    try {
        await check('both accounts own a crown (the folded one older) and wear it; the folded one also wears a name effect', async () => {
            goneCrown = await own(gone, 'hat_crown', 'g1', '2026-01-01T00:00:00.000Z');
            goneFire = await own(gone, 'fx_fire', 'g2', '2026-02-01T00:00:00.000Z');
            keepCrown = await own(keep, 'hat_crown', 'k1', '2026-06-01T00:00:00.000Z');
            bobCrown = await own(bob, 'hat_crown', 'b1', '2025-01-01T00:00:00.000Z');
            await inv.equip(gone.subject, `user:${gone.subject}`, { kind: 'live.hat', slot: 'hat', instance_id: goneCrown });
            await inv.equip(gone.subject, `user:${gone.subject}`, { kind: 'live.name_effect', slot: 'name_effect', instance_id: goneFire });
            await inv.equip(keep.subject, `user:${keep.subject}`, { kind: 'live.hat', slot: 'hat', instance_id: keepCrown });
            goneLedger = await count('SELECT count(*) FROM inventory_ledger WHERE owner_subject = $1', [gone.subject]);
            assert.ok(goneLedger >= 4);
        });

        await check('a payload that is not a merge, or not from Network, is acknowledged and ignored', async () => {
            const bad = await deliver(merged('evt_01JZ0000000000000000000M00', { from: keep.subject }));
            assert.deepStrictEqual([bad.status, bad.json.outcome], [200, 'ignored:payload']);
            const spoof = await deliver(merged('evt_01JZ0000000000000000000M09', {}, 'live'));
            assert.deepStrictEqual([spoof.status, spoof.json.outcome], [200, 'ignored:source']);
            assert.strictEqual(await count('SELECT count(*) FROM inventory_instances WHERE owner_subject = $1', [gone.subject]), 2);
        });

        await check('the merge moves every item, keeps the oldest crown, and the survivor\'s equipped set wins', async () => {
            const r = await deliver(merged('evt_01JZ0000000000000000000M01'));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'merged'], JSON.stringify(r.json));
            assert.strictEqual(await count('SELECT count(*) FROM inventory_instances WHERE owner_subject = $1', [gone.subject]), 0, 'no copy under the folded subject');
            assert.strictEqual(await count('SELECT count(*) FROM inventory_equipped WHERE owner_subject = $1', [gone.subject]), 0);
            const rows = await db.many('SELECT id, state FROM inventory_instances WHERE owner_subject = $1 ORDER BY id', [keep.subject]);
            const state = Object.fromEntries(rows.map((x) => [x.id, x.state]));
            assert.deepStrictEqual(state, { [goneCrown]: 'owned', [goneFire]: 'owned', [keepCrown]: 'revoked' }, 'both instances kept as records; the older crown is the one owned');
            const eq = await db.many('SELECT kind, slot, instance_id FROM inventory_equipped WHERE owner_subject = $1 ORDER BY kind', [keep.subject]);
            assert.deepStrictEqual(eq, [
                { kind: 'live.hat', slot: 'hat', instance_id: goneCrown }, // the survivor's slot, now on the crown kept
                { kind: 'live.name_effect', slot: 'name_effect', instance_id: goneFire }, // a slot only the folded account filled
            ]);
            const rec = await db.maybe('SELECT from_subject, into_subject, instances, duplicates, equipped, equipped_dropped FROM inventory_subject_merges WHERE merge_id = $1', [MERGE]);
            assert.deepStrictEqual(rec, { from_subject: gone.subject, into_subject: keep.subject, instances: 2, duplicates: 1, equipped: 1, equipped_dropped: 1 });
        });

        await check('the ledger keeps the folded account\'s rows and gains one merged row per instance', async () => {
            assert.strictEqual(await count('SELECT count(*) FROM inventory_ledger WHERE owner_subject = $1', [gone.subject]), goneLedger, 'history is never rewritten');
            const lines = await db.many("SELECT instance_id, reason, actor, detail->>'merge_id' AS merge_id FROM inventory_ledger WHERE action = 'merged' ORDER BY instance_id");
            assert.strictEqual(lines.length, 3);
            assert.ok(lines.every((l) => l.merge_id === MERGE && l.actor === 'service:network'));
            assert.strictEqual(lines.find((l) => l.instance_id === keepCrown).reason, 'account_merge_duplicate_revoked');
            assert.strictEqual(lines.find((l) => l.instance_id === goneFire).reason, 'account_merge');
        });

        await check('a redelivery, or the same merge under another event id, changes nothing; bob is untouched', async () => {
            const before = await count('SELECT count(*) FROM inventory_ledger');
            assert.strictEqual((await deliver(merged('evt_01JZ0000000000000000000M01'))).json.outcome, 'unchanged');
            assert.strictEqual((await deliver(merged('evt_01JZ0000000000000000000M02'))).json.outcome, 'unchanged');
            assert.strictEqual(await count('SELECT count(*) FROM inventory_ledger'), before);
            assert.strictEqual(await count("SELECT count(*) FROM inventory_instances WHERE owner_subject = $1 AND state = 'owned'", [keep.subject]), 2);
            assert.deepStrictEqual(await db.maybe('SELECT owner_subject, state FROM inventory_instances WHERE id = $1', [bobCrown]), { owner_subject: bob.subject, state: 'owned' });
        });

        await check('the merge topic is subscribed beside the account topics', async () => {
            const src = require('fs').readFileSync(require('path').join(__dirname, '../server/index.js'), 'utf8');
            assert.ok(/topics: \[\.\.\.ACCOUNT_TOPICS, subjectMerge\.TOPIC\]/.test(src));
        });
    } finally {
        await t.close();
    }
    done();
})();
