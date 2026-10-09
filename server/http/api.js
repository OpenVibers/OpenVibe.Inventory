'use strict';

/**
 * /api/v1 — OpenVibe.Inventory's API (ADR-054; the capabilities are openvibe-contracts manifests/capabilities/inventory.*).
 *
 *   GET  /ping                                   public            liveness
 *   GET  /kinds, /kinds/:id                      inventory.item.read      the kinds (inventory.kind@1)
 *   GET  /definitions?kind=&issuer=              inventory.item.read      published definitions (inventory.definition@1)
 *   GET  /definitions/:id                        inventory.item.read      one definition (any status, for its issuer)
 *   GET  /people/:subject/items?kind=&cursor=    inventory.item.read      a person's public inventory (inventory.inventory@1)
 *   GET  /people/:subject/equipped               inventory.item.read      their equipped set (inventory.equipped@1)
 *   GET  /equipped?subjects=a,b,…                inventory.item.read      up to 100 equipped sets (inventory.equipped-batch@1)
 *   GET  /me/items                               inventory.item.list      the caller's own inventory, every state
 *   PUT  /me/equipped                            inventory.equip.manage   equip or clear a slot (inventory.equip-request@1)
 *   POST /grants                                 inventory.item.grant     an issuer grants an instance (inventory.grant-request@1)
 *   POST /instances/:id/consume | /revoke        inventory.item.consume   an issuer uses up or takes back an instance
 *   POST /definitions, PATCH /definitions/:id    inventory.definition.manage  an issuer's definitions
 *
 * A person acts for themself (their token or this site's session). A service or app acting for a person sends that
 * person's subject in X-OV-Subject and holds the route's capability. Nothing here sells, buys, trades or converts an
 * item (ADR-054 §5). A refusal is an RFC 9457 problem+json with a stable code.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { InventoryError, SUBJECT_RE } = require('../inventory/store');

function createApi(ctx) {
    const { config, principal, limits, inv } = ctx;
    const r = asyncRouter();
    const read = principal.requireRead('inventory.item.read');

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    /** The person a request acts for: a person's own subject, or a service's X-OV-Subject. */
    function personOf(req, res) {
        const p = req.principal;
        if (p.kind === 'user') return p.requester.slice(5);
        const s = String(req.get('x-ov-subject') || '');
        if (SUBJECT_RE.test(s)) return s;
        http.sendProblem(res, 400, 'inventory.subject_required', { detail: 'A service acting for a person sends X-OV-Subject: usr_…', ctx: req.ov });
        return null;
    }
    const issuerOf = (req) => req.principal.requester;
    const wrap = (fn) => async (req, res) => {
        try { return await fn(req, res); } catch (err) {
            if (err instanceof InventoryError) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov });
            throw err;
        }
    };

    r.get('/ping', limits.reads('inventory.item.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Public reads ──────────────────────────────────────
    r.get('/kinds', read, limits.reads('inventory.item.read'), wrap(async (_req, res) => res.json({ kinds: await inv.listKinds() })));
    r.get('/kinds/:id', read, limits.reads('inventory.item.read'), wrap(async (req, res) => {
        const k = await inv.getKind(req.params.id);
        return k ? res.json({ kind: k }) : http.sendProblem(res, 404, 'inventory.unknown_kind', { detail: 'no such kind', ctx: req.ov });
    }));
    r.get('/definitions', read, limits.reads('inventory.item.read'), wrap(async (req, res) => res.json({
        definitions: await inv.listDefinitions({ kind: req.query.kind ? String(req.query.kind) : null, issuer: req.query.issuer ? String(req.query.issuer) : null, limit: req.query.limit }),
    })));
    r.get('/definitions/:id', read, limits.reads('inventory.item.read'), wrap(async (req, res) => {
        const d = await inv.getDefinition(req.params.id);
        // A draft or an item in review is its issuer's to see.
        if (!d || (d.status !== 'published' && d.status !== 'retired' && req.principal.requester !== d.issuer)) return http.sendProblem(res, 404, 'inventory.definition_not_found', { detail: 'no such definition', ctx: req.ov });
        return res.json({ definition: d });
    }));
    r.get('/people/:subject/items', read, limits.reads('inventory.item.read'), wrap(async (req, res) => res.json(await inv.inventory(req.params.subject, {
        cursor: req.query.cursor || null, limit: req.query.limit, kind: req.query.kind ? String(req.query.kind) : null,
    }))));
    r.get('/people/:subject/equipped', read, limits.reads('inventory.item.read'), wrap(async (req, res) => {
        if (!SUBJECT_RE.test(req.params.subject)) return http.sendProblem(res, 404, 'inventory.unknown_subject', { detail: 'a usr_ subject', ctx: req.ov });
        return res.json((await inv.equipped([req.params.subject]))[0]);
    }));
    r.get('/equipped', read, limits.reads('inventory.item.read'), wrap(async (req, res) => {
        const subjects = String(req.query.subjects || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (subjects.length > 100) return http.sendProblem(res, 400, 'inventory.too_many_subjects', { detail: 'at most 100 subjects per call', ctx: req.ov });
        return res.json({ equipped: await inv.equipped(subjects) });
    }));

    // ── The person's own ──────────────────────────────────
    r.get('/me/items', principal.requireCapability('inventory.item.list'), limits.reads('inventory.item.list'), wrap(async (req, res) => {
        const subject = personOf(req, res);
        if (!subject) return undefined;
        return res.json(await inv.inventory(subject, { own: true, cursor: req.query.cursor || null, limit: req.query.limit, kind: req.query.kind ? String(req.query.kind) : null }));
    }));
    r.put('/me/equipped', principal.requireCapability('inventory.equip.manage'), limits.budget('inventory.equip'), wrap(async (req, res) => {
        const subject = personOf(req, res);
        if (!subject) return undefined;
        return res.json(await inv.equip(subject, req.principal.kind === 'user' ? req.principal.requester : issuerOf(req), req.body));
    }));

    // ── Issuers ───────────────────────────────────────────
    r.post('/grants', principal.requireCapability('inventory.item.grant'), limits.budget('inventory.grant'), wrap(async (req, res) => {
        const out = await inv.grant(issuerOf(req), req.body);
        return res.status(out.created ? 201 : 200).json({ instance: out.instance, created: out.created });
    }));
    r.post('/instances/:id/consume', principal.requireCapability('inventory.item.consume'), limits.budget('inventory.grant'), wrap(async (req, res) => res.json({ instance: await inv.consume(issuerOf(req), req.params.id) })));
    r.post('/instances/:id/revoke', principal.requireCapability('inventory.item.consume'), limits.budget('inventory.grant'), wrap(async (req, res) => res.json({
        instance: await inv.consume(issuerOf(req), req.params.id, { revoke: true, reason: req.body && typeof req.body.reason === 'string' ? req.body.reason.slice(0, 200) : null }),
    })));
    r.post('/definitions', principal.requireCapability('inventory.definition.manage'), limits.budget('inventory.define'), wrap(async (req, res) => res.status(201).json({ definition: await inv.createDefinition(issuerOf(req), req.body) })));
    // Staff decide on a Workshop item in review (ADR-054 §6): a person whose Network role is staff, nobody else.
    r.post('/definitions/:id/review', limits.budget('inventory.define'), wrap(async (req, res) => {
        const staff = req.principal.kind === 'user' && req.viewer && req.viewer.kind === 'user' && ['admin', 'global_mod'].includes(req.viewer.role);
        if (!staff) return http.sendProblem(res, 403, 'inventory.staff_only', { detail: 'Only OpenVibe staff review Workshop items', ctx: req.ov });
        return res.json({ definition: await inv.review(req.principal.requester, req.params.id, req.body || {}) });
    }));
    r.patch('/definitions/:id', principal.requireCapability('inventory.definition.manage'), limits.budget('inventory.define'), wrap(async (req, res) => res.json({ definition: await inv.updateDefinition(issuerOf(req), req.params.id, req.body) })));

    return r;
}

module.exports = { createApi };
