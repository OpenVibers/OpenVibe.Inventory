'use strict';

/**
 * OpenVibe.Inventory — process entry. `node server/index.js`
 * Listens on PORT (5030) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the timers clear, the Events subscriptions and the
 * outbox relay stop, the JWKS refresher stops and the store closes. Exported so a test can inject `exit` and
 * `signals: false`. `extra` is what start() adds (the subscriptions).
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Inventory', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, ...extra, () => ctx.searchIndex.stop(), () => ctx.outbox.stop(), () => ctx.keys.client.stop(), () => ctx.s.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Inventory] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.keys.client.start();
    ctx.outbox.start();
    ctx.searchIndex.start();
    // The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
    // INVENTORY_EVENTS_SECRET or the client secret.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });
    // Sent events older than a week go (openvibe-sdk outbox prune), every six hours.
    const prune = setInterval(() => { Promise.resolve(ctx.outbox.outbox.prune()).catch(() => {}); }, 6 * 3600 * 1000);
    prune.unref();

    createLifecycle({ server, ctx, timers: [prune], extra: [() => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Inventory] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
