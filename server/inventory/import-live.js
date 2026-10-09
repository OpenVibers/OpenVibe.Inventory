'use strict';

/**
 * ADR-054 §8, convert and verify: Live's cosmetics (user_cosmetics and user_equipped in Live's database, read only) become
 * instances and equipped slots here, for each person's Network subject. scripts/import-live.js runs these.
 *
 *   importLive({ live, inv, db, apply })  grants each unlock as an instance with origin `migrated`, issued by
 *                                         service:live, keeping its unlock time, under the grant key
 *                                         live-migration:<user_id>:<item_id> (a second run grants nothing again);
 *                                         then equips each person's slots. Without apply, counts what it would do.
 *   verifyLive({ live, inv, db })         each person's unlocked set and equipped slots, row for row → differences
 *                                         (items no longer in Live's catalog are listed apart, as unknown)
 *
 * A Live account without a Network subject cannot hold items; it is counted, never guessed.
 */
const { LIVE } = require('./seed');

const SLOT_KIND = { name_effect: 'live.name_effect', particle: 'live.particle', hat: 'live.hat', voice: 'live.voice' };
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Live's rows per subject: subject → { userId, items: Map(item_id → unlocked_at), slots: Map(slot → item_id) }. */
async function liveRows(live) {
    // Live learns a person's Network subject from their token and keeps it in linked_accounts (service 'network').
    const items = await live.many(`SELECT c.user_id, la.subject_id, c.item_id, c.unlocked_at FROM user_cosmetics c
        LEFT JOIN linked_accounts la ON la.user_id = c.user_id AND la.service = 'network' ORDER BY c.user_id, c.item_id`);
    const slots = await live.many(`SELECT e.user_id, la.subject_id, e.slot, e.item_id FROM user_equipped e
        LEFT JOIN linked_accounts la ON la.user_id = e.user_id AND la.service = 'network' ORDER BY e.user_id, e.slot`);
    const by = new Map();
    const noSubject = new Set();
    const of = (r) => {
        if (!SUBJECT_RE.test(String(r.subject_id || ''))) { noSubject.add(Number(r.user_id)); return null; }
        if (!by.has(r.subject_id)) by.set(r.subject_id, { userId: Number(r.user_id), items: new Map(), slots: new Map() });
        return by.get(r.subject_id);
    };
    for (const r of items) { const p = of(r); if (p) p.items.set(r.item_id, r.unlocked_at); }
    for (const r of slots) { const p = of(r); if (p) p.slots.set(r.slot, r.item_id); }
    return { by, noSubject: noSubject.size, unlocks: items.length, equippedSlots: slots.length };
}

/** Live's ov_now() text ('2026-09-01 12:00:00', UTC) or an ISO time → ISO, else null. */
function isoOf(v) {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? String(v) : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function importLive({ live, inv, db, apply = false, log = console }) {
    const rows = await liveRows(live);
    const out = { people: rows.by.size, unlocks: rows.unlocks, equippedSlots: rows.equippedSlots, noSubject: rows.noSubject, granted: 0, alreadyHere: 0, equipped: 0, unknown: [], notOwned: 0 };
    const defs = new Map();
    const def = async (alias) => { if (!defs.has(alias)) defs.set(alias, await inv.byAlias(LIVE, alias)); return defs.get(alias); };
    for (const [subject, p] of rows.by) {
        for (const [itemId, unlockedAt] of p.items) {
            const d = await def(itemId);
            if (!d) { out.unknown.push(itemId); continue; }
            if (!apply) { out.granted++; continue; }
            const r = await inv.grant(LIVE, { definition_id: d.id, subject, idempotency_key: `live-migration:${p.userId}:${itemId}`, origin: 'migrated', reason: 'moved from OpenVibe.Live', acquired_at: isoOf(unlockedAt) || undefined }, { allowMigrated: true });
            if (r.created) out.granted++; else out.alreadyHere++;
        }
        for (const [slot, itemId] of p.slots) {
            const kind = SLOT_KIND[slot];
            const d = kind ? await def(itemId) : null;
            if (!d) { out.unknown.push(itemId); continue; }
            if (!apply) { out.equipped++; continue; }
            const inst = await db.maybe("SELECT id FROM inventory_instances WHERE definition_id = $1 AND owner_subject = $2 AND state = 'owned' LIMIT 1", [d.id, subject]);
            if (!inst) { out.notOwned++; log.warn(`[import-live] ${subject} wears ${itemId} in ${slot} without owning it in Live; left empty`); continue; }
            await inv.equip(subject, LIVE, { kind, slot, instance_id: inst.id });
            out.equipped++;
        }
    }
    out.unknown = [...new Set(out.unknown)];
    return out;
}

async function verifyLive({ live, inv, db }) {
    const rows = await liveRows(live);
    const differences = [];
    const unknown = new Set();
    const known = new Map();
    const isKnown = async (alias) => { if (!known.has(alias)) known.set(alias, !!(await inv.byAlias(LIVE, alias))); return known.get(alias); };
    for (const [subject, p] of rows.by) {
        const mine = await db.many(`SELECT a.alias FROM inventory_instances i JOIN inventory_definition_aliases a ON a.definition_id = i.definition_id AND a.issuer = $2
            WHERE i.owner_subject = $1 AND i.state = 'owned'`, [subject, LIVE]);
        const have = new Set(mine.map((r) => r.alias));
        const missing = [];
        for (const x of p.items.keys()) {
            if (have.has(x)) continue;
            // An item Live no longer has in its catalog was never imported (importLive names it); it is not a difference.
            if (await isKnown(x)) missing.push(x); else unknown.add(x);
        }
        const eq = (await inv.equipped([subject]))[0].slots;
        const worn = new Map();
        for (const [key, v] of Object.entries(eq)) {
            const a = await db.maybe('SELECT alias FROM inventory_definition_aliases WHERE definition_id = $1 AND issuer = $2', [v.definition_id, LIVE]);
            worn.set(key.split(':')[1], a ? a.alias : null);
        }
        // A slot Live has but whose item Live does not own is left empty on purpose (importLive counts it as notOwned).
        const slots = [...p.slots].filter(([slot, item]) => p.items.has(item) && worn.get(slot) !== item).map(([slot]) => slot);
        if (missing.length || slots.length) differences.push({ subject, missing, slots });
    }
    return { people: rows.by.size, unlocks: rows.unlocks, equippedSlots: rows.equippedSlots, noSubject: rows.noSubject, differences, unknown: [...unknown] };
}

module.exports = { importLive, verifyLive, liveRows, isoOf, SLOT_KIND };
