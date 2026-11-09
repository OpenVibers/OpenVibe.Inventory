'use strict';

const { InventoryError, DEF_RE, actorOf } = require('./store');
const fail = (status, code, detail) => { throw new InventoryError(status, code, detail); };
const PURCHASE_RE = /^isp_[0-9A-HJKMNP-TV-Z]{26}$/;

function createCommerce(ctx, { fetchImpl = globalThis.fetch } = {}) {
    const { s, inv, outbox, config } = ctx;
    const db = s.db;
    function pricesOf(prices) {
        if (!prices || typeof prices !== 'object' || Array.isArray(prices) || !Object.keys(prices).length ||
            Object.entries(prices).some(([k, v]) => !['coins', 'vibes'].includes(k) || !Number.isSafeInteger(v) || v < 1)) {
            fail(422, 'inventory.invalid_prices', 'Offer positive whole prices in coins, vibes, or both');
        }
        return prices;
    }
    async function submit(issuer, id, input) {
        if (!DEF_RE.test(id)) fail(404, 'inventory.definition_not_found', 'No such item');
        const prices = pricesOf(input.prices);
        return s.tx(async () => {
            const def = await db.maybe('SELECT * FROM inventory_definitions WHERE id = $1 FOR UPDATE', [id]);
            if (!def || def.issuer !== issuer) fail(403, 'inventory.not_issuer', 'List only items issued by your app');
            if (def.status !== 'published') fail(409, 'inventory.not_published', 'Publish the item before listing it');
            const kind = await inv.getKind(def.kind);
            if (kind.stackable) fail(422, 'inventory.store_nonstackable', 'The cosmetic store sells one owned item per person');
            await db.exec(`INSERT INTO inventory_store_listings (definition_id, issuer, prices, status, updated_at)
                VALUES ($1, $2, $3, 'in_review', $4) ON CONFLICT (definition_id) DO UPDATE
                SET prices = excluded.prices, status = 'in_review', reviewed_by = NULL, updated_at = excluded.updated_at`,
            [id, issuer, JSON.stringify(prices), s.iso()]);
            return { definition_id: id, issuer, prices, status: 'in_review' };
        });
    }
    async function review(staff, id, approve) {
        if (typeof approve !== 'boolean') fail(422, 'inventory.invalid_review', 'approve is a boolean');
        const r = await db.maybe(`UPDATE inventory_store_listings SET status = $2, reviewed_by = $3, updated_at = $4
            WHERE definition_id = $1 RETURNING definition_id, issuer, prices, status`, [id, approve ? 'published' : 'rejected', staff, s.iso()]);
        if (!r) fail(404, 'inventory.listing_not_found', 'No listing to review');
        return r;
    }
    async function list(subject = null) {
        const rows = await db.many(`SELECT l.definition_id, l.issuer, l.prices, d.name, d.description, d.art, d.kind,
            d.supply_cap, d.supply_issued, k.slots, k.surfaces,
            EXISTS(SELECT 1 FROM inventory_instances i WHERE i.definition_id = d.id AND i.owner_subject = $1 AND i.state = 'owned') AS owned
            FROM inventory_store_listings l JOIN inventory_definitions d ON d.id = l.definition_id
            JOIN inventory_kinds k ON k.id = d.kind WHERE l.status = 'published' AND d.status = 'published'
            ORDER BY d.name, d.id LIMIT 200`, [subject]);
        return { items: rows.map((r) => ({ id: r.definition_id, name: r.name, description: r.description || '', issuer: r.issuer,
            prices: r.prices, preview: r.art, kind: r.kind, slots: r.slots, surfaces: r.surfaces, owned: r.owned,
            available: r.supply_cap == null || Number(r.supply_issued) < Number(r.supply_cap) })) };
    }
    function present(p) {
        return { id: p.id, subject: p.subject, item_id: p.definition_id, name: p.name, issuer: p.issuer,
            currency: p.currency, amount: Number(p.amount), status: p.instance_id ? 'fulfilled' : 'pending',
            instance_id: p.instance_id || null, payment_id: p.payment_id || null };
    }
    async function purchase(subject, id) {
        if (!PURCHASE_RE.test(id)) fail(404, 'inventory.purchase_not_found', 'No such purchase');
        const p = await db.maybe('SELECT * FROM inventory_store_purchases WHERE id = $1 AND subject = $2', [id, subject]);
        if (!p) fail(404, 'inventory.purchase_not_found', 'No such purchase');
        return present(p);
    }
    async function reserve(subject, id, input) {
        if (!DEF_RE.test(id)) fail(404, 'inventory.definition_not_found', 'No such item');
        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key || '') || !['coins', 'vibes'].includes(input.currency)) {
            fail(422, 'inventory.invalid_purchase', 'Send currency and an idempotency_key of 8–128 characters');
        }
        // Lock the definition exactly as ordinary grants do; the reserved serial counts against the supply cap.
        return s.tx(async () => {
            const d = await db.maybe('SELECT * FROM inventory_definitions WHERE id = $1 FOR UPDATE', [id]);
            if (!d) fail(404, 'inventory.definition_not_found', 'No such item');
            const old = await db.maybe('SELECT * FROM inventory_store_purchases WHERE subject = $1 AND idempotency_key = $2', [subject, input.idempotency_key]);
            if (old) {
                if (old.definition_id !== id || old.currency !== input.currency) fail(409, 'inventory.key_reused', 'This key names another purchase');
                return old;
            }
            const prior = await db.maybe('SELECT * FROM inventory_store_purchases WHERE subject = $1 AND definition_id = $2', [subject, id]);
            if (prior) {
                if (prior.currency !== input.currency) fail(409, 'inventory.purchase_pending', 'Resume the existing purchase in its original currency');
                return prior;
            }
            const owned = await db.maybe("SELECT id FROM inventory_instances WHERE definition_id = $1 AND owner_subject = $2 AND state = 'owned'", [id, subject]);
            if (owned) fail(409, 'inventory.already_owned', 'You already own this item');
            const listing = await db.maybe("SELECT * FROM inventory_store_listings WHERE definition_id = $1 AND status = 'published'", [id]);
            if (!listing || d.status !== 'published') fail(404, 'inventory.listing_not_found', 'This item is not for sale');
            const amount = listing.prices[input.currency];
            if (!Number.isSafeInteger(amount) || amount <= 0) fail(422, 'inventory.currency_not_offered', 'This currency is not offered');
            if (d.supply_cap != null && Number(d.supply_issued) >= Number(d.supply_cap)) fail(409, 'inventory.supply_exhausted', 'This item is sold out');
            const serial = d.supply_cap == null ? null : Number(d.supply_issued) + 1;
            await db.exec('UPDATE inventory_definitions SET supply_issued = supply_issued + 1 WHERE id = $1', [id]);
            return db.maybe(`INSERT INTO inventory_store_purchases
                (id, subject, definition_id, idempotency_key, currency, amount, name, issuer, serial, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [s.newId('isp'), subject, id, input.idempotency_key, input.currency, amount, d.name, d.issuer, serial, s.iso()]);
        });
    }
    async function pay(p, authorization) {
        let r, body;
        try {
            r = await fetchImpl(`${config.billingUrl}/api/v1/me/store/spend`, { method: 'POST',
                headers: { Authorization: authorization, 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error',
                body: JSON.stringify({ purchase_id: p.id }), signal: AbortSignal.timeout(15000) });
            body = await r.json();
        } catch { fail(504, 'inventory.payment_unknown', 'Payment is not confirmed. Retry this purchase to recover its original result.'); }
        if (!r.ok) fail(r.status, body.code || 'inventory.payment_failed', body.detail || 'Payment was refused');
        if (!body.payment_id || body.purchase_id !== p.id || body.currency !== p.currency || Number(body.amount) !== Number(p.amount)) {
            fail(502, 'inventory.payment_unknown', 'Payment confirmation is invalid; retry this purchase');
        }
        return body;
    }
    async function fulfill(p, paid) {
        return s.tx(async () => {
            const row = await db.maybe('SELECT * FROM inventory_store_purchases WHERE id = $1 FOR UPDATE', [p.id]);
            if (row.instance_id) return present(row);
            // A reserved, paid item is delivered even if the listing changed while payment was in flight.
            await db.maybe('SELECT id FROM inventory_definitions WHERE id = $1 FOR UPDATE', [p.definition_id]);
            let inst = await db.maybe("SELECT id FROM inventory_instances WHERE definition_id = $1 AND owner_subject = $2 AND state = 'owned'", [p.definition_id, p.subject]);
            if (!inst) {
                inst = { id: s.newId('inv') };
                await db.exec(`INSERT INTO inventory_instances (id, definition_id, owner_subject, origin, state, attributes, serial, acquired_at, updated_at)
                    VALUES ($1,$2,$3,'granted','owned','{}',$4,$5,$5)`, [inst.id, p.definition_id, p.subject, p.serial, s.iso()]);
                const def = await inv.getDefinition(p.definition_id);
                await outbox.emit({ event_type: 'inventory.item.granted', version: 1, source: 'inventory', actor: actorOf('service:inventory'),
                    subject: { type: 'user', id: p.subject }, visibility: 'subject',
                    payload: { instance_id: inst.id, definition_id: p.definition_id, kind: def.kind, owner: p.subject, origin: 'granted', issuer: p.issuer } });
            } else {
                await db.exec('UPDATE inventory_definitions SET supply_issued = supply_issued - 1 WHERE id = $1', [p.definition_id]);
            }
            await inv.ledger('purchased', { owner: p.subject, instance: inst.id, definition: p.definition_id, actor: `user:${p.subject}`,
                detail: { purchase_id: p.id, payment_id: paid.payment_id, currency: p.currency, amount: Number(p.amount) } });
            await db.exec('UPDATE inventory_store_purchases SET instance_id = $2, payment_id = $3 WHERE id = $1', [p.id, inst.id, paid.payment_id]);
            return present({ ...row, instance_id: inst.id, payment_id: paid.payment_id });
        });
    }
    async function buy(subject, id, input, authorization) {
        const p = await reserve(subject, id, input);
        if (p.instance_id) return present(p);
        return fulfill(p, await pay(p, authorization));
    }
    return { list, submit, review, purchase, buy };
}

module.exports = { createCommerce };
