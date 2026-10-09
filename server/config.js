'use strict';

/**
 * OpenVibe.Inventory configuration. Every value comes from the environment (production: /etc/openvibe/inventory.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5030);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://inventory.openvibe.network' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'inventory',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.INVENTORY_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.INVENTORY_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (INVENTORY_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.INVENTORY_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:inventory:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        // Network's rule for every grant: the audience is openvibe.<service> (not the site's host name).
        audience: env.INVENTORY_AUDIENCE || 'openvibe.inventory',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'inventory',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events: the outbox relay publishes inventory.item.* and inventory.definition.published when EVENTS_URL
        // and the client secret are set (otherwise events wait in event_outbox). INVENTORY_EVENTS_SECRET signs the
        // deliveries to POST /internal/events (account export and deletion, ADR-033; comma-separated for rotation, 32+
        // characters each); unset, the route answers 503 and no subscription is created at boot.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: Math.max(50, int(env.EVENTS_RELAY_INTERVAL_MS, 2000)),
            secrets: String(env.INVENTORY_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
        },
        // The Workshop's images (server/workshop/media.js): this service's own tenant in OpenVibe.Media. Without the
        // key, submitting an image says uploads are not set up yet; everything else works.
        media: {
            url: trim(env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100'),
            app: env.INVENTORY_MEDIA_APP || 'inventory',
            appKey: env.INVENTORY_MEDIA_APP_KEY || '',
            timeoutMs: Math.max(1000, int(env.INVENTORY_MEDIA_TIMEOUT_MS, 15000)),
        },
    };
}

module.exports = { load };
