'use strict';

/**
 * network.subject.merged → Inventory (ADR-029, ADR-054 §7). Two Network accounts became one: `from` is now an alias of
 * `into`, and every item of `from` becomes `into`'s, in one transaction, once per merge_id (inventory_subject_merges):
 *
 *   instances   every instance moves to the survivor. Where both own the same item of a non-stackable kind, the
 *               oldest is kept and the other is revoked (reason account_merge), so nobody holds two of a unique item
 *   equipped    the survivor's equipped set wins: a slot only `from` filled moves, a slot both filled keeps the
 *               survivor's; a slot pointing at a revoked duplicate now points at the kept one
 *   Workshop    items `from` made are credited to, and managed by, the survivor
 *   ledger      append-only: `from`'s rows stay as written; each moved or revoked instance gets a `merged` row
 *
 * Delivered to POST /internal/events beside the account topics (openvibe-sdk/account-data's consumer, onEvent).
 */
const TOPIC = 'network.subject.merged';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACTOR = 'service:network';

/** One envelope → 'merged' | 'unchanged' | 'ignored:<why>'. */
async function apply(ev, { s, log = console }) {
    if (!ev || ev.event_type !== TOPIC) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const mergeId = String(p.merge_id || ''), from = String(p.from || ''), into = String(p.into || '');
    if (!MERGE_RE.test(mergeId) || !SUBJECT_RE.test(from) || !SUBJECT_RE.test(into) || from === into) return 'ignored:payload';
    const r = await s.tx(async () => {
        const db = s.db;
        if (await db.maybe('SELECT 1 FROM inventory_subject_merges WHERE merge_id = $1', [mergeId])) return null;
        const at = s.iso();
        const detail = JSON.stringify({ merge_id: mergeId, from, into });
        // Both own the same non-stackable item: the oldest is kept, every other copy is revoked.
        const dupes = await db.many(`WITH owned AS (
                SELECT i.id, i.definition_id, i.owner_subject,
                       row_number() OVER (PARTITION BY i.definition_id ORDER BY i.acquired_at, i.id) AS rn,
                       first_value(i.id) OVER (PARTITION BY i.definition_id ORDER BY i.acquired_at, i.id) AS keeper,
                       min(i.owner_subject) OVER (PARTITION BY i.definition_id) AS lo,
                       max(i.owner_subject) OVER (PARTITION BY i.definition_id) AS hi
                FROM inventory_instances i
                JOIN inventory_definitions d ON d.id = i.definition_id
                JOIN inventory_kinds k ON k.id = d.kind
                WHERE i.owner_subject IN ($1, $2) AND i.state = 'owned' AND NOT k.stackable)
            SELECT id, definition_id, keeper FROM owned WHERE rn > 1 AND lo <> hi ORDER BY id`, [from, into]);
        for (const d of dupes) {
            await db.exec('UPDATE inventory_equipped SET instance_id = $2 WHERE instance_id = $1', [d.id, d.keeper]);
            await db.exec("UPDATE inventory_instances SET state = 'revoked', updated_at = $2 WHERE id = $1", [d.id, at]);
        }
        // The survivor's equipped set wins; a slot only `from` filled moves.
        const equippedDropped = Number(await db.exec(`DELETE FROM inventory_equipped f USING inventory_equipped k
            WHERE f.owner_subject = $1 AND k.owner_subject = $2 AND k.kind = f.kind AND k.slot = f.slot`, [from, into])) || 0;
        const equipped = Number(await db.exec('UPDATE inventory_equipped SET owner_subject = $2 WHERE owner_subject = $1', [from, into])) || 0;
        // Two equipped rows may now point at one kept instance (both wore their copy in different slots): fine, an
        // instance can only fill the slot its kind allows, and both rows are the survivor's.
        const moved = await db.many('UPDATE inventory_instances SET owner_subject = $2, updated_at = $3 WHERE owner_subject = $1 RETURNING id, definition_id', [from, into, at]);
        const dupeIds = new Set(dupes.map((d) => d.id));
        for (const m of moved) {
            await db.exec(`INSERT INTO inventory_ledger (at, action, owner_subject, instance_id, definition_id, actor, reason, detail)
                VALUES ($1, 'merged', $2, $3, $4, $5, $6, $7)`, [at, into, m.id, m.definition_id, ACTOR, dupeIds.has(m.id) ? 'account_merge_duplicate_revoked' : 'account_merge', detail]);
        }
        for (const d of dupes) {
            if (moved.some((m) => m.id === d.id)) continue;
            await db.exec(`INSERT INTO inventory_ledger (at, action, owner_subject, instance_id, definition_id, actor, reason, detail)
                VALUES ($1, 'merged', $2, $3, $4, $5, 'account_merge_duplicate_revoked', $6)`, [at, into, d.id, d.definition_id, ACTOR, detail]);
        }
        // Workshop: what `from` made is the survivor's to manage, with the survivor's credit.
        await db.exec('UPDATE inventory_definitions SET credit_subject = $2 WHERE credit_subject = $1', [from, into]);
        await db.exec('UPDATE inventory_definitions SET issuer = $2 WHERE issuer = $1', [`user:${from}`, `user:${into}`]);
        await db.exec(`INSERT INTO inventory_subject_merges (merge_id, from_subject, into_subject, instances, duplicates, equipped, equipped_dropped, merged_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [mergeId, from, into, moved.length, dupes.length, equipped, equippedDropped, at]);
        return { instances: moved.length, duplicates: dupes.length, equipped, equippedDropped };
    });
    if (!r) return 'unchanged';
    log.log(`[Merge] ${mergeId}: ${r.instances} instance(s) and ${r.equipped} equipped slot(s) now the survivor's; ${r.duplicates} duplicate(s) revoked, ${r.equippedDropped} equipped slot(s) dropped`);
    return 'merged';
}

module.exports = { apply, TOPIC };
