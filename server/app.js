'use strict';

/**
 * OpenVibe.Inventory — Express app factory; server/index.js listens, tests build their own instance with a temp database
 * and a mock Network.
 *
 *   /, /updates                                       the pages (http/pages.js)
 *   /api/v1/*                                         the API (http/api.js)
 *   /auth/*                                           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics  (loopback only)
 *
 * The product fills this in: its routes in http/api.js, its pages in http/pages.js, its capabilities in
 * http/principal.js and its budgets in http/caller-limits.js. The plumbing here (helmet, SSO, legal pages,
 * static assets, the API mount, the 404 and the error handler) stays.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createWorkshopRoutes } = require('./workshop/pages');
const { createWorkshopMedia } = require('./workshop/media');
const { createPeople } = require('./workshop/people');
const { createServiceReadiness } = require('./observability');
const { createCallerLimits } = require('./http/caller-limits');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSearchIndex } = require('./search-index');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createInventory } = require('./inventory/store');
const { seed } = require('./inventory/seed');
const accountDataLib = require('./inventory/account-data');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * opts: config, store, now (clock), fetchImpl (Network), log, limitsNow, callerLimits (false: count nobody,
 * tests only), valkey, eventsFetch (the outbox relay's fetch, tests), accountSend (a stand-in for Network's internal
 * routes, tests)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    // The inventory (ADR-054) and its events, written in the same transaction as each change.
    const outbox = createServiceOutbox({
        db: s.db, source: 'inventory', eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        now: s.now, fetch: opts.eventsFetch || fetchImpl, log,
    });
    const inv = createInventory({ s, outbox, log });
    await seed(inv, { log });
    // Item pages in OpenVibe.Search (./search-index.js) through the same outbox: the definition writes name what they
    // changed (watch), and a sweep runs on its own timer once server/index.js starts it.
    const searchIndex = opts.searchIndex || createSearchIndex({ config, s, outbox, log });
    searchIndex.watch(inv);
    // Account export and deletion (ADR-033): the table map, and the sender to Network's internal routes with this
    // service's own client-credentials token.
    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Inventory cannot answer account events'); });
    const ctx = { config, s, keys, sso, principal, log, outbox, inv, accountData, searchIndex };
    // The Workshop (ADR-054 §6): images in this service's own Media tenant, recipients by @name through the Network.
    ctx.workshopMedia = opts.workshopMedia || createWorkshopMedia({ config, fetchImpl: opts.fetchImpl, log });
    ctx.people = opts.people || createPeople({ config, fetchImpl: opts.fetchImpl });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'inventory', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'inventory', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createCallerLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.callerLimits !== false, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── OpenVibe.Events → Inventory (loopback only: nginx answers 404 for /internal/) ──
    // network.account.export_requested and network.account.deleted, answered by openvibe-sdk/account-data's consumer,
    // which reads the raw body itself (the v2 signature covers it) and refuses a request that came through a proxy.
    app.post('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, log }));

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res, next) => outbox.status().then((events) => res.json({ status: 'ok', service: 'openvibe-inventory', version: VERSION, events }), next));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'inventory', service: 'inventory', host: 'inventory.openvibe.network', name: 'OpenVibe.Inventory', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    // Public reads from any site: the catalog and anyone's items and equipped set answer every origin, without
    // credentials (openvibe-shared/items.js draws what people wear with them, on every OpenVibe site). Everything else
    // keeps the same-site resource policy and no CORS. A preflight is answered here.
    const PUBLIC_READ = /^\/(?:kinds(?:\/[^/]+)?|definitions(?:\/[^/]+)?|equipped|people\/[^/]+\/(?:items|equipped))$/;
    app.use('/api/v1', (req, res, next) => {
        if (!PUBLIC_READ.test(req.path) || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        if (req.method !== 'OPTIONS') return next();
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Accept');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    });
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.INVENTORY_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.INVENTORY_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use(createWorkshopRoutes(ctx));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/">the home page</a> or <a href="/updates">the update log</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies.
        log.error('[OpenVibe.Inventory]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
