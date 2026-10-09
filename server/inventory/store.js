'use strict';

/**
 * The inventory (ADR-054): kinds, definitions, instances, the equipped set and the ledger, and the only writes to them.
 * Every movement writes one ledger row and one event in the same transaction as the change.
 *
 *   kinds          list, get, upsert (seed only: kinds are contracts, registered at boot from server/data/kinds.json)
 *   definitions    list, get, byAlias, create, update; only the kind's issuer defines items in its namespace
 *   grant          an issuer gives one instance to a person: idempotent per (issuer, key), honours the supply cap; a
 *                  non-stackable item the person already owns answers the instance they have
 *   consume        an issuer uses up or revokes an instance it issued
 *   inventory      a person's instances with their definitions (public: owned ones of published or retired items)
 *   equipped       many people's equipped sets in one query; equip, clear
 *
 * Nothing here sells, buys, trades or converts an item (ADR-054 §5): there is no price column and no such route.
 */
const Ajv = require('ajv/dist/2020');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEF_RE = /^itd_[0-9A-HJKMNP-TV-Z]{26}$/;
const INST_RE = /^inv_[0-9A-HJKMNP-TV-Z]{26}$/;
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

class InventoryError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}
const fail = (status, code, detail) => { throw new InventoryError(status, code, detail); };

/** 'service:live' → { type: 'service', id: 'live' } (the event envelope's actor). */
function actorOf(requester) {
    const [type, ...rest] = String(requester).split(':');
    return { type: type === 'user' ? 'user' : type === 'app' ? 'app' : type === 'agent' ? 'agent' : 'service', id: rest.join(':') };
}

function kindRow(r) {
    return { id: r.id, name: r.name, description: r.description || undefined, slots: r.slots, surfaces: r.surfaces, attributes: r.attribute_schema, stackable: r.stackable, issuer: r.issuer };
}

function definitionRow(r, aliases = []) {
    const out = {
        id: r.id, kind: r.kind, name: r.name, art: r.art, rarity: r.rarity, attributes: r.attributes || {}, issuer: r.issuer,
        supply: { cap: r.supply_cap == null ? null : Number(r.supply_cap), issued: Number(r.supply_issued) },
        status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    };
    if (r.description) out.description = r.description;
    if (aliases.length) out.aliases = aliases;
    if (r.published_at) out.published_at = r.published_at;
    if (r.credit_subject || r.credit_name) out.credit = { ...(r.credit_subject ? { subject: r.credit_subject } : {}), ...(r.credit_name ? { name: r.credit_name } : {}) };
    return out;
}

function instanceRow(r) {
    const out = { id: r.id, definition_id: r.definition_id, owner: r.owner_subject, origin: r.origin, state: r.state, acquired_at: r.acquired_at };
    if (r.attributes && Object.keys(r.attributes).length) out.attributes = r.attributes;
    if (r.serial != null) out.serial = Number(r.serial);
    return out;
}

const encodeCursor = (r) => Buffer.from(`${r.acquired_at}|${r.id}`).toString('base64url');
function decodeCursor(c) {
    if (!c) return null;
    const [at, id] = Buffer.from(String(c), 'base64url').toString('utf8').split('|');
    return at && INST_RE.test(id || '') ? { at, id } : fail(400, 'inventory.bad_cursor', 'cursor is not one this service gave');
}

function createInventory({ s, outbox, log = console }) {
    const db = s.db;
    const ajv = new Ajv({ strict: false, allErrors: false });
    const validators = new Map();   // kind id + updated_at → compiled attribute schema

    async function emit(event_type, { subject, visibility, actor, payload }) {
        await outbox.emit({ event_type, version: 1, source: 'inventory', actor: actorOf(actor), subject, visibility, payload });
    }

    async function ledger(action, { owner = null, instance = null, definition = null, actor, reason = null, detail = {} }) {
        await db.exec(`INSERT INTO inventory_ledger (at, action, owner_subject, instance_id, definition_id, actor, reason, detail)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [s.iso(), action, owner, instance, definition, actor, reason, JSON.stringify(detail)]);
    }

    // ── Kinds ─────────────────────────────────────────────
    async function getKind(id) {
        const r = await db.maybe('SELECT * FROM inventory_kinds WHERE id = $1', [String(id || '')]);
        return r ? kindRow(r) : null;
    }
    async function listKinds() { return (await db.many('SELECT * FROM inventory_kinds ORDER BY id')).map(kindRow); }
    async function upsertKind(k) {
        const now = s.iso();
        await db.exec(`INSERT INTO inventory_kinds (id, name, description, slots, surfaces, attribute_schema, stackable, issuer, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, slots = excluded.slots, surfaces = excluded.surfaces,
                attribute_schema = excluded.attribute_schema, stackable = excluded.stackable, issuer = excluded.issuer, updated_at = excluded.updated_at
            WHERE (inventory_kinds.name, inventory_kinds.description, inventory_kinds.slots, inventory_kinds.surfaces, inventory_kinds.attribute_schema, inventory_kinds.stackable, inventory_kinds.issuer)
                IS DISTINCT FROM (excluded.name, excluded.description, excluded.slots, excluded.surfaces, excluded.attribute_schema, excluded.stackable, excluded.issuer)`,
        [k.id, k.name, k.description || null, JSON.stringify(k.slots || []), JSON.stringify(k.surfaces || []), JSON.stringify(k.attribute_schema || { type: 'object' }), !!k.stackable, k.issuer, now]);
    }
    async function checkAttributes(kind, attributes) {
        const row = await db.maybe('SELECT attribute_schema, updated_at FROM inventory_kinds WHERE id = $1', [kind]);
        const key = `${kind}@${row.updated_at}`;
        if (!validators.has(key)) validators.set(key, ajv.compile(row.attribute_schema));
        const validate = validators.get(key);
        if (!validate(attributes || {})) fail(422, 'inventory.bad_attributes', `attributes do not fit ${kind}: ${ajv.errorsText(validate.errors)}`);
    }

    // ── Definitions ───────────────────────────────────────
    async function aliasesOf(ids) {
        if (!ids.length) return new Map();
        const rows = await db.many('SELECT definition_id, alias FROM inventory_definition_aliases WHERE definition_id = ANY($1::text[]) ORDER BY alias', [ids]);
        const m = new Map();
        for (const r of rows) { if (!m.has(r.definition_id)) m.set(r.definition_id, []); m.get(r.definition_id).push(r.alias); }
        return m;
    }
    async function getDefinition(id) {
        if (!DEF_RE.test(String(id || ''))) return null;
        const r = await db.maybe('SELECT * FROM inventory_definitions WHERE id = $1', [id]);
        if (!r) return null;
        return definitionRow(r, (await aliasesOf([r.id])).get(r.id) || []);
    }
    async function byAlias(issuer, alias) {
        const r = await db.maybe('SELECT definition_id FROM inventory_definition_aliases WHERE issuer = $1 AND alias = $2', [issuer, String(alias || '')]);
        return r ? await getDefinition(r.definition_id) : null;
    }
    async function listDefinitions({ kind = null, issuer = null, statuses = ['published'], limit = 200 } = {}) {
        const rows = await db.many(`SELECT * FROM inventory_definitions WHERE status = ANY($1::text[])
            AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR issuer = $3) ORDER BY kind, name LIMIT $4`,
        [statuses, kind, issuer, Math.max(1, Math.min(500, Number(limit) || 200))]);
        const aliases = await aliasesOf(rows.map((r) => r.id));
        return rows.map((r) => definitionRow(r, aliases.get(r.id) || []));
    }

    function checkDefinitionBody(b, { partial = false } = {}) {
        const has = (k) => b[k] !== undefined;
        if (!partial || has('name')) if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) fail(422, 'inventory.bad_name', 'name is 1 to 80 characters');
        if (has('description') && b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) fail(422, 'inventory.bad_description', 'description is at most 500 characters');
        if (!partial || has('art')) {
            const a = b.art;
            if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.keys(a).length) fail(422, 'inventory.bad_art', 'art names a Media object (media_id), a renderer token or an emoji');
            for (const k of Object.keys(a)) if (!['media_id', 'token', 'emoji'].includes(k)) fail(422, 'inventory.bad_art', `art has no field ${k}`);
            if (a.media_id !== undefined && !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(a.media_id))) fail(422, 'inventory.bad_art', 'art.media_id is a med_ id');
            if (a.token !== undefined && (typeof a.token !== 'string' || !a.token || a.token.length > 80)) fail(422, 'inventory.bad_art', 'art.token is 1 to 80 characters');
            if (a.emoji !== undefined && (typeof a.emoji !== 'string' || a.emoji.length > 16)) fail(422, 'inventory.bad_art', 'art.emoji is at most 16 characters');
        }
        if (!partial || has('rarity')) if (!RARITY.includes(b.rarity)) fail(422, 'inventory.bad_rarity', `rarity is one of ${RARITY.join(', ')}`);
        if (has('supply_cap') && b.supply_cap !== null && !(Number.isInteger(b.supply_cap) && b.supply_cap > 0)) fail(422, 'inventory.bad_supply', 'supply_cap is a positive whole number or null');
        if (has('aliases') && (!Array.isArray(b.aliases) || b.aliases.length > 8 || b.aliases.some((x) => !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(String(x))))) fail(422, 'inventory.bad_alias', 'aliases: up to 8 lower-case ids');
    }

    /** A definition in the kind's namespace, by the kind's issuer (services and apps; creators open with the Workshop). */
    async function createDefinition(requester, b, { status = null } = {}) {
        if (!b || typeof b !== 'object') fail(400, 'request.bad_body', 'send inventory.definition-request@1');
        const kind = await getKind(b.kind);
        if (!kind) fail(422, 'inventory.unknown_kind', `no kind ${b.kind}`);
        if (kind.issuer !== requester) fail(403, 'inventory.not_issuer', `only ${kind.issuer} defines ${kind.id} items (community items open with the Workshop, ADR-054 §6)`);
        checkDefinitionBody(b);
        await checkAttributes(kind.id, b.attributes || {});
        const id = s.newId('itd');
        const now = s.iso();
        const st = status || (b.publish ? 'published' : 'draft');
        return await s.tx(async () => {
            await db.exec(`INSERT INTO inventory_definitions (id, kind, name, description, art, rarity, attributes, issuer, supply_cap, status, created_at, updated_at, published_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
            [id, kind.id, b.name.trim(), b.description || null, JSON.stringify(b.art), b.rarity, JSON.stringify(b.attributes || {}), requester, b.supply_cap || null, st, now, st === 'published' ? now : null]);
            for (const alias of b.aliases || []) {
                const taken = await db.maybe('SELECT definition_id FROM inventory_definition_aliases WHERE issuer = $1 AND alias = $2', [requester, alias]);
                if (taken) fail(409, 'inventory.alias_taken', `${alias} already names ${taken.definition_id}`);
                await db.exec('INSERT INTO inventory_definition_aliases (issuer, alias, definition_id) VALUES ($1, $2, $3)', [requester, alias, id]);
            }
            await ledger('defined', { definition: id, actor: requester, detail: { kind: kind.id, status: st } });
            if (st === 'published') await emit('inventory.definition.published', { subject: { type: 'item_definition', id }, visibility: 'public', actor: requester, payload: { definition_id: id, kind: kind.id, name: b.name.trim(), rarity: b.rarity, issuer: requester } });
            return await getDefinition(id);
        });
    }

    /** Edit a definition its issuer owns: name, description and art any time; rarity, attributes and cap until it is published. */
    async function updateDefinition(requester, id, b) {
        if (!b || typeof b !== 'object') fail(400, 'request.bad_body', 'send the fields to change');
        return await s.tx(async () => {
            const cur = await db.maybe('SELECT * FROM inventory_definitions WHERE id = $1 FOR UPDATE', [String(id || '')]);
            if (!cur) fail(404, 'inventory.definition_not_found', 'no such definition');
            if (cur.issuer !== requester) fail(403, 'inventory.not_issuer', 'only its issuer edits a definition');
            checkDefinitionBody(b, { partial: true });
            const locked = cur.status === 'published' || cur.status === 'retired';
            for (const k of ['rarity', 'attributes', 'supply_cap', 'kind']) if (locked && b[k] !== undefined) fail(409, 'inventory.published', `${k} cannot change once the item is published (its owners rely on it)`);
            if (b.attributes !== undefined) await checkAttributes(cur.kind, b.attributes);
            let status = cur.status;
            if (b.status === 'retired') status = 'retired';
            else if (b.publish && cur.status === 'draft') status = 'published';
            else if (b.status !== undefined && b.status !== cur.status && b.status !== 'retired') fail(422, 'inventory.bad_status', 'status: retired, or publish: true on a draft');
            const now = s.iso();
            await db.exec(`UPDATE inventory_definitions SET name = $2, description = $3, art = $4, rarity = $5, attributes = $6, supply_cap = $7, status = $8,
                updated_at = $9, published_at = COALESCE(published_at, CASE WHEN $8 = 'published' THEN $9 END) WHERE id = $1`,
            [cur.id, b.name !== undefined ? b.name.trim() : cur.name, b.description !== undefined ? b.description : cur.description,
                JSON.stringify(b.art !== undefined ? b.art : cur.art), b.rarity !== undefined ? b.rarity : cur.rarity,
                JSON.stringify(b.attributes !== undefined ? b.attributes : cur.attributes), b.supply_cap !== undefined ? b.supply_cap : cur.supply_cap, status, now]);
            await ledger(status !== cur.status ? status : 'edited', { definition: cur.id, actor: requester });
            if (status === 'published' && cur.status !== 'published') {
                await emit('inventory.definition.published', { subject: { type: 'item_definition', id: cur.id }, visibility: 'public', actor: requester, payload: { definition_id: cur.id, kind: cur.kind, name: b.name !== undefined ? b.name.trim() : cur.name, rarity: b.rarity || cur.rarity, issuer: cur.issuer } });
            }
            return await getDefinition(cur.id);
        });
    }

    // ── Grants ────────────────────────────────────────────
    /**
     * One instance of a published definition the requester issued, to a person. → { instance, created }.
     * origin 'migrated' is the migration's alone (scripts/import-live.js), never the API's.
     */
    async function grant(requester, b, { allowMigrated = false } = {}) {
        if (!b || typeof b !== 'object') fail(400, 'request.bad_body', 'send inventory.grant-request@1');
        if (!DEF_RE.test(String(b.definition_id || ''))) fail(422, 'inventory.bad_definition', 'definition_id is an itd_ id');
        if (!SUBJECT_RE.test(String(b.subject || ''))) fail(422, 'inventory.bad_subject', 'items go to people: a usr_ subject');
        const key = String(b.idempotency_key || '');
        if (key.length < 8 || key.length > 128) fail(422, 'inventory.bad_key', 'idempotency_key is 8 to 128 characters');
        const origin = b.origin || 'granted';
        if (!['granted', 'earned'].concat(allowMigrated ? ['migrated'] : []).includes(origin)) fail(422, 'inventory.bad_origin', 'origin is granted or earned (nothing is bought or traded, ADR-054 §5)');
        if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) fail(422, 'inventory.bad_reason', 'reason is at most 200 characters');
        return await s.tx(async () => {
            const prior = await db.maybe('SELECT instance_id FROM inventory_grants WHERE issuer = $1 AND idempotency_key = $2', [requester, key]);
            if (prior) return { instance: instanceRow(await db.maybe('SELECT * FROM inventory_instances WHERE id = $1', [prior.instance_id])), created: false };
            const def = await db.maybe('SELECT * FROM inventory_definitions WHERE id = $1 FOR UPDATE', [b.definition_id]);
            if (!def) fail(404, 'inventory.definition_not_found', 'no such definition');
            if (def.issuer !== requester) fail(403, 'inventory.not_issuer', `only ${def.issuer} grants this item`);
            if (def.status !== 'published') fail(409, 'inventory.not_published', `the item is ${def.status}`);
            const kind = await getKind(def.kind);
            if (b.attributes !== undefined) await checkAttributes(kind.id, { ...def.attributes, ...b.attributes });
            if (!kind.stackable) {
                const have = await db.maybe("SELECT * FROM inventory_instances WHERE definition_id = $1 AND owner_subject = $2 AND state = 'owned' LIMIT 1", [def.id, b.subject]);
                if (have) {
                    await db.exec('INSERT INTO inventory_grants (issuer, idempotency_key, instance_id, created_at) VALUES ($1, $2, $3, $4)', [requester, key, have.id, s.iso()]);
                    return { instance: instanceRow(have), created: false };
                }
            }
            if (def.supply_cap != null && Number(def.supply_issued) >= Number(def.supply_cap)) fail(409, 'inventory.supply_exhausted', `all ${def.supply_cap} have been given`);
            const serial = def.supply_cap != null ? Number(def.supply_issued) + 1 : null;
            const id = s.newId('inv');
            const now = s.iso();
            await db.exec('UPDATE inventory_definitions SET supply_issued = supply_issued + 1 WHERE id = $1', [def.id]);
            await db.exec(`INSERT INTO inventory_instances (id, definition_id, owner_subject, origin, state, attributes, serial, acquired_at, updated_at)
                VALUES ($1, $2, $3, $4, 'owned', $5, $6, $7, $7)`, [id, def.id, b.subject, origin, JSON.stringify(b.attributes || {}), serial, allowMigrated && b.acquired_at ? b.acquired_at : now]);
            await db.exec('INSERT INTO inventory_grants (issuer, idempotency_key, instance_id, created_at) VALUES ($1, $2, $3, $4)', [requester, key, id, now]);
            await ledger(origin, { owner: b.subject, instance: id, definition: def.id, actor: requester, reason: b.reason || null });
            await emit('inventory.item.granted', { subject: { type: 'user', id: b.subject }, visibility: 'subject', actor: requester,
                payload: { instance_id: id, definition_id: def.id, kind: def.kind, owner: b.subject, origin, issuer: requester } });
            return { instance: instanceRow(await db.maybe('SELECT * FROM inventory_instances WHERE id = $1', [id])), created: true };
        });
    }

    /** An issuer uses up (consume) or takes back (revoke) an instance of an item it issued. */
    async function consume(requester, instanceId, { revoke = false, reason = null } = {}) {
        if (!INST_RE.test(String(instanceId || ''))) fail(404, 'inventory.instance_not_found', 'no such instance');
        return await s.tx(async () => {
            const inst = await db.maybe('SELECT i.*, d.issuer FROM inventory_instances i JOIN inventory_definitions d ON d.id = i.definition_id WHERE i.id = $1 FOR UPDATE OF i', [instanceId]);
            if (!inst) fail(404, 'inventory.instance_not_found', 'no such instance');
            if (inst.issuer !== requester) fail(403, 'inventory.not_issuer', `only ${inst.issuer} consumes or revokes this item`);
            if (inst.state !== 'owned') fail(409, 'inventory.not_owned', `the instance is ${inst.state}`);
            const state = revoke ? 'revoked' : 'consumed';
            await db.exec('UPDATE inventory_instances SET state = $2, updated_at = $3 WHERE id = $1', [inst.id, state, s.iso()]);
            await db.exec('DELETE FROM inventory_equipped WHERE instance_id = $1', [inst.id]);
            await ledger(state, { owner: inst.owner_subject, instance: inst.id, definition: inst.definition_id, actor: requester, reason });
            const payload = revoke
                ? { instance_id: inst.id, definition_id: inst.definition_id, owner: inst.owner_subject, reason: String(reason || 'revoked by its issuer').slice(0, 200) }
                : { instance_id: inst.id, definition_id: inst.definition_id, owner: inst.owner_subject, issuer: requester };
            await emit(revoke ? 'inventory.item.revoked' : 'inventory.item.consumed', { subject: { type: 'user', id: inst.owner_subject }, visibility: 'subject', actor: requester, payload });
            return instanceRow(await db.maybe('SELECT * FROM inventory_instances WHERE id = $1', [inst.id]));
        });
    }

    // ── Reading ───────────────────────────────────────────
    /** inventory.inventory@1. own: every state; public: owned instances of published or retired items. */
    async function inventory(subject, { own = false, cursor = null, limit = 100, kind = null } = {}) {
        if (!SUBJECT_RE.test(String(subject || ''))) fail(404, 'inventory.unknown_subject', 'a usr_ subject');
        const after = decodeCursor(cursor);
        const n = Math.max(1, Math.min(200, Number(limit) || 100));
        const rows = await db.many(`SELECT i.* FROM inventory_instances i JOIN inventory_definitions d ON d.id = i.definition_id
            WHERE i.owner_subject = $1 AND ($2::boolean OR (i.state = 'owned' AND d.status IN ('published', 'retired')))
              AND ($3::text IS NULL OR d.kind = $3)
              AND ($4::text IS NULL OR (i.acquired_at, i.id) < ($4, $5))
            ORDER BY i.acquired_at DESC, i.id DESC LIMIT $6`, [subject, own, kind, after ? after.at : null, after ? after.id : null, n + 1]);
        const page = rows.slice(0, n);
        const defIds = [...new Set(page.map((r) => r.definition_id))];
        const defs = defIds.length ? await db.many('SELECT * FROM inventory_definitions WHERE id = ANY($1::text[])', [defIds]) : [];
        const aliases = await aliasesOf(defIds);
        return {
            subject,
            instances: page.map(instanceRow),
            definitions: Object.fromEntries(defs.map((d) => [d.id, definitionRow(d, aliases.get(d.id) || [])])),
            next_cursor: rows.length > n ? encodeCursor(page[page.length - 1]) : null,
        };
    }

    /** Many people's equipped sets (inventory.equipped@1 each), in one query. Unknown or empty subjects get {}. */
    async function equipped(subjects) {
        const list = [...new Set((subjects || []).map(String))].filter((x) => SUBJECT_RE.test(x)).slice(0, 100);
        if (!list.length) return [];
        const rows = await db.many(`SELECT e.owner_subject, e.kind, e.slot, e.instance_id, e.updated_at, i.definition_id, d.art->>'token' AS token
            FROM inventory_equipped e JOIN inventory_instances i ON i.id = e.instance_id JOIN inventory_definitions d ON d.id = i.definition_id
            WHERE e.owner_subject = ANY($1::text[]) AND i.state = 'owned' ORDER BY e.owner_subject, e.kind, e.slot`, [list]);
        const by = new Map(list.map((x) => [x, { subject: x, slots: {}, updated_at: null }]));
        for (const r of rows) {
            const e = by.get(r.owner_subject);
            e.slots[`${r.kind}:${r.slot}`] = { instance_id: r.instance_id, definition_id: r.definition_id, ...(r.token ? { token: r.token } : {}) };
            if (!e.updated_at || r.updated_at > e.updated_at) e.updated_at = r.updated_at;
        }
        const fallback = s.iso();
        return [...by.values()].map((e) => ({ ...e, updated_at: e.updated_at || fallback }));
    }

    /** Equip an owned instance in a slot of its kind, or clear the slot (instance_id null). → inventory.equipped@1. */
    async function equip(subject, actor, b) {
        if (!SUBJECT_RE.test(String(subject || ''))) fail(403, 'inventory.no_subject', 'equipping is for a person');
        if (!b || typeof b !== 'object') fail(400, 'request.bad_body', 'send inventory.equip-request@1');
        const kind = await getKind(b.kind);
        if (!kind) fail(422, 'inventory.unknown_kind', `no kind ${b.kind}`);
        if (!kind.slots.includes(b.slot)) fail(422, 'inventory.bad_slot', `${kind.id} has the slots ${kind.slots.join(', ') || '(none: not equippable)'}`);
        await s.tx(async () => {
            if (b.instance_id === null) {
                const cur = await db.maybe('DELETE FROM inventory_equipped WHERE owner_subject = $1 AND kind = $2 AND slot = $3 RETURNING instance_id', [subject, kind.id, b.slot]);
                if (cur) {
                    await ledger('unequipped', { owner: subject, instance: cur.instance_id, actor, detail: { kind: kind.id, slot: b.slot } });
                    await emit('inventory.item.unequipped', { subject: { type: 'user', id: subject }, visibility: 'public', actor, payload: { kind: kind.id, slot: b.slot, owner: subject } });
                }
                return;
            }
            const inst = await db.maybe(`SELECT i.*, d.kind FROM inventory_instances i JOIN inventory_definitions d ON d.id = i.definition_id
                WHERE i.id = $1 AND i.owner_subject = $2 AND i.state = 'owned'`, [String(b.instance_id || ''), subject]);
            if (!inst) fail(409, 'inventory.not_owned', 'you do not own that item (or it was used up)');
            if (inst.kind !== kind.id) fail(422, 'inventory.wrong_kind', `that item is a ${inst.kind}, not a ${kind.id}`);
            const now = s.iso();
            await db.exec(`INSERT INTO inventory_equipped (owner_subject, kind, slot, instance_id, updated_at) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (owner_subject, kind, slot) DO UPDATE SET instance_id = excluded.instance_id, updated_at = excluded.updated_at`, [subject, kind.id, b.slot, inst.id, now]);
            await ledger('equipped', { owner: subject, instance: inst.id, definition: inst.definition_id, actor, detail: { kind: kind.id, slot: b.slot } });
            await emit('inventory.item.equipped', { subject: { type: 'user', id: subject }, visibility: 'public', actor, payload: { instance_id: inst.id, definition_id: inst.definition_id, kind: kind.id, slot: b.slot, owner: subject } });
        });
        return (await equipped([subject]))[0];
    }

    return {
        listKinds, getKind, upsertKind, listDefinitions, getDefinition, byAlias, createDefinition, updateDefinition,
        grant, consume, inventory, equipped, equip, ledger,
    };
}

module.exports = { createInventory, InventoryError, actorOf, SUBJECT_RE, DEF_RE, INST_RE, RARITY };
