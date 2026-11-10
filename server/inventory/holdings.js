'use strict';

// Stacked, snapshot-bounded reads. The boundary is the newest instance present on page one;
// grants made during scrolling cannot move an existing stack or create a new one in later pages.
const { InventoryError, SUBJECT_RE, RARITY } = require('./store');
const SORTS = new Set(['newest', 'name', 'rarity', 'count']);
const bad = (detail) => { throw new InventoryError(400, 'inventory.bad_holdings_query', detail); };
const cursorError = () => { throw new InventoryError(400, 'inventory.bad_cursor', 'cursor does not match these filters and sort'); };

function optionsOf(input = {}) {
    const sort = String(input.sort || 'newest');
    if (!SORTS.has(sort)) bad('sort must be newest, name, rarity or count');
    const limit = input.limit == null ? 60 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) bad('limit must be from 1 to 200');
    const equipped = input.equipped == null ? null : String(input.equipped);
    const tradable = input.tradable == null ? null : String(input.tradable);
    if (equipped != null && !['true', 'false'].includes(equipped)) bad('equipped must be true or false');
    if (tradable != null && !['true', 'false'].includes(tradable)) bad('tradable must be true or false');
    const issuer = input.issuer ? String(input.issuer) : input.site ? `service:${String(input.site)}` : null;
    const filter = { issuer, kind: input.kind ? String(input.kind) : null, rarity: input.rarity ? String(input.rarity) : null,
        equipped, tradable, text: input.text ? String(input.text).trim().slice(0, 100).toLowerCase() : null, sort };
    if (filter.rarity && !RARITY.includes(filter.rarity)) bad('unknown rarity');
    return { filter, limit };
}

function createHoldings(db) {
    function conditions(subject, own, f, upper) {
        const p = [subject];
        const bind = (v) => { p.push(v); return `$${p.length}`; };
        const where = [`i.owner_subject = $1`, `i.state = 'owned'`];
        if (!own) where.push("d.status IN ('published', 'retired')");
        if (upper) where.push(`(i.acquired_at, i.id) <= (${bind(upper.at)}, ${bind(upper.id)})`);
        if (f.issuer) where.push(`d.issuer = ${bind(f.issuer)}`);
        if (f.kind) where.push(`d.kind = ${bind(f.kind)}`);
        if (f.rarity) where.push(`d.rarity = ${bind(f.rarity)}`);
        if (f.text) where.push(`position(${bind(f.text)} in lower(d.name)) > 0`);
        if (f.equipped) where.push(`${f.equipped === 'true' ? '' : 'NOT '}EXISTS (SELECT 1 FROM inventory_equipped e
            JOIN inventory_instances ei ON ei.id = e.instance_id WHERE e.owner_subject = i.owner_subject AND ei.definition_id = i.definition_id)`);
        // Inventory has no trade or transfer operation; every holding is currently non-tradable.
        if (f.tradable === 'true') where.push('false');
        return { p, bind, where: where.join(' AND ') };
    }

    async function count(subject, { own = false, ...input } = {}) {
        if (!SUBJECT_RE.test(String(subject))) throw new InventoryError(404, 'inventory.unknown_subject', 'a usr_ subject');
        const { filter } = optionsOf(input);
        const q = conditions(subject, own, filter, null);
        const total = await db.value(`SELECT count(DISTINCT i.definition_id) FROM inventory_instances i
            JOIN inventory_definitions d ON d.id = i.definition_id WHERE ${q.where}`, q.p);
        return { subject, count: Number(total) };
    }

    async function page(subject, { own = false, cursor = null, ...input } = {}) {
        if (!SUBJECT_RE.test(String(subject))) throw new InventoryError(404, 'inventory.unknown_subject', 'a usr_ subject');
        const { filter, limit } = optionsOf(input);
        const signature = JSON.stringify([subject, own, filter]);
        let state;
        if (cursor) {
            try { state = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()); } catch { cursorError(); }
            if (!state || state.signature !== signature || typeof state.key !== 'string' || typeof state.id !== 'string' ||
                !state.upper || typeof state.upper.at !== 'string' || typeof state.upper.id !== 'string') cursorError();
        }
        const upper = state ? state.upper : await db.maybe(`SELECT acquired_at AS at, id FROM inventory_instances
            WHERE owner_subject = $1 AND state = 'owned' ORDER BY acquired_at DESC, id DESC LIMIT 1`, [subject]);
        if (!upper) return { subject, holdings: [], next_cursor: null };
        const q = conditions(subject, own, filter, upper);
        const key = { newest: "max(i.acquired_at || '|' || i.id)", name: 'lower(d.name)', rarity: "CASE d.rarity WHEN 'common' THEN '0' WHEN 'uncommon' THEN '1' WHEN 'rare' THEN '2' WHEN 'epic' THEN '3' ELSE '4' END", count: "lpad(count(*)::text, 12, '0')" }[filter.sort];
        const direction = filter.sort === 'name' ? 'ASC' : 'DESC';
        const rows = filter.sort === 'newest' ? await db.many(`WITH heads AS MATERIALIZED (
            SELECT i.*, d.kind, d.name, d.description, d.art, d.rarity, d.issuer, d.status,
                k.slots AS kind_slots, i.id AS representative_id, (i.acquired_at || '|' || i.id) COLLATE "C" AS sort_key,
                EXISTS (SELECT 1 FROM inventory_equipped e JOIN inventory_instances ei ON ei.id = e.instance_id
                    WHERE e.owner_subject = i.owner_subject AND ei.definition_id = i.definition_id) AS equipped
            FROM inventory_instances i JOIN inventory_definitions d ON d.id = i.definition_id
            JOIN inventory_kinds k ON k.id = d.kind
            WHERE ${q.where}
              AND NOT EXISTS (SELECT 1 FROM inventory_instances newer WHERE newer.owner_subject = i.owner_subject
                  AND newer.definition_id = i.definition_id AND newer.state = 'owned'
                  AND (newer.acquired_at, newer.id) > (i.acquired_at, i.id)
                  AND (newer.acquired_at, newer.id) <= (${q.bind(upper.at)}, ${q.bind(upper.id)}))
              ${state ? `AND (i.acquired_at || '|' || i.id, i.definition_id) < (${q.bind(state.key)}, ${q.bind(state.id)})` : ''}
            ORDER BY i.acquired_at DESC, i.id DESC LIMIT ${q.bind(limit + 1)}
        ) SELECT h.*, (SELECT count(*)::int FROM inventory_instances si WHERE si.owner_subject = h.owner_subject
            AND si.definition_id = h.definition_id AND si.state = 'owned'
            AND (si.acquired_at, si.id) <= (${q.bind(upper.at)}, ${q.bind(upper.id)})) AS quantity
            FROM heads h ORDER BY h.acquired_at DESC, h.id DESC`, q.p) : await db.many(`WITH groups AS (
            SELECT i.definition_id, count(*)::int AS quantity, ${key} COLLATE "C" AS sort_key,
                   (array_agg(i.id ORDER BY i.acquired_at DESC, i.id DESC))[1] AS representative_id
            FROM inventory_instances i JOIN inventory_definitions d ON d.id = i.definition_id
            WHERE ${q.where} GROUP BY i.definition_id, d.name, d.rarity
        ) SELECT g.*, i.*, d.*, k.slots AS kind_slots,
            EXISTS (SELECT 1 FROM inventory_equipped e JOIN inventory_instances ei ON ei.id = e.instance_id
                    WHERE e.owner_subject = i.owner_subject AND ei.definition_id = i.definition_id) AS equipped
          FROM groups g JOIN inventory_instances i ON i.id = g.representative_id
          JOIN inventory_definitions d ON d.id = g.definition_id
          JOIN inventory_kinds k ON k.id = d.kind
          ${state ? `WHERE (g.sort_key, g.definition_id) ${direction === 'ASC' ? '>' : '<'} (${q.bind(state.key)}, ${q.bind(state.id)})` : ''}
          ORDER BY g.sort_key ${direction}, g.definition_id ${direction} LIMIT ${q.bind(limit + 1)}`, q.p);
        const shown = rows.slice(0, limit);
        return { subject, holdings: shown.map((r) => ({
            definition: { id: r.definition_id, kind: r.kind, name: r.name, description: r.description || undefined,
                art: r.art, rarity: r.rarity, issuer: r.issuer, status: r.status },
            instance: { id: r.representative_id, definition_id: r.definition_id, owner: subject,
                state: 'owned', acquired_at: r.acquired_at, ...(r.serial == null ? {} : { serial: Number(r.serial) }) },
            count: r.quantity, equipped: r.equipped, tradable: false, kind_slots: r.kind_slots,
        })), next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ signature, upper, key: shown.at(-1).sort_key, id: shown.at(-1).definition_id })).toString('base64url') : null };
    }
    return { page, count };
}

module.exports = { createHoldings };
