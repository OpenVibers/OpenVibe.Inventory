'use strict';

/**
 * Per-caller rate limits at OpenVibe.Inventory's API (openvibe-sdk/limits). The per-address limits in app.js stay; these
 * count requests by who makes them:
 *
 *   a person               user:usr_… (a Bearer token or this site's session)
 *   an app, agent, service app:app_… / agent:agt_… / service:<slug>
 *   anyone else            ip:<address>
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After before it does any work; the
 * refusal is logged once and counted in inventory_rate_limited_total{limit,window}. Reads take INVENTORY_LIMITS_MINUTE /
 * INVENTORY_LIMITS_HOUR (120 and 3000); the product's expensive routes get their own numbers in BUDGETS below.
 * Counters live in this process unless VALKEY_URL is set.
 *
 * Never limited here: /api/health, /api/ready, /release.json, /metrics, sign-in and the pages.
 */
const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');

function caller(req) {
    const p = req.principal;
    if (p && p.requester) return p.requester;
    const v = req.viewer;
    if (v && v.kind === 'user' && v.subject) return `user:${v.subject}`;
    return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

/**
 * The product's expensive routes, each with its numbers per caller (a minute, an hour). A route takes its entry
 * with `limits.budget('<name>')`; an unknown name throws, so a route can never be counted by a budget that was
 * not declared here, e.g.
 *
 *   'inventory.thing.create': { minute: 6, hour: 60 },
 */
const BUDGETS = {
    // Equipping: a person changing what they wear (a few dozen a minute is a lot).
    'inventory.equip': { minute: 30, hour: 600 },
    // Grants, consumes and revokes by an issuer: games and events grant in bursts.
    'inventory.grant': { minute: 600, hour: 20000 },
    // Defining items.
    'inventory.define': { minute: 30, hour: 300 },
};

function createCallerLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'inventory_rate_limited_total', help: 'Requests refused 429 by a per-caller limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? caller : () => null,
        now,
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The caller is a subject, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createCallerLimits, caller, BUDGETS };
