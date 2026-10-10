'use strict';

/**
 * Inventory's item pages in OpenVibe.Search (openvibe-publishing/search-feed): one search.index-document@1 per item
 * definition page (/items/<id>), sent as inventory.index_document.upserted|deleted through the outbox Inventory's own
 * events already use. A published item is a document; a retired one stays (its page still answers) but is marked
 * noindex, as its page is; a draft or an item in review is a tombstone, as its page answers 404. The document carries
 * what the page shows: name, rarity, kind, description, who gives it and how to get it. Never who owns it.
 *
 * The write paths that change a definition (create, edit, Workshop edit, review, takedown) name it to touch() (see
 * server/app.js); touched items sync a moment later, each in its own transaction. A sweep a minute after boot and
 * every ten minutes catches anything else (the seed, an account deletion that makes Workshop items authorless):
 * inventory_index_revisions is the sequencer, so it re-sends only what changed.
 */
const { createSearchFeed } = require('openvibe-publishing/search-feed');

const FLUSH_MS = 250;
const START_DELAY_MS = 60_000;
const INTERVAL_MS = 10 * 60_000;
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const SELECT = `SELECT d.*, k.name AS kind_name, k.slots AS kind_slots FROM inventory_definitions d JOIN inventory_kinds k ON k.id = d.kind`;

const issuerName = (row) => (String(row.issuer).startsWith('service:')
    ? `OpenVibe.${row.issuer.slice(8).replace(/^./, (c) => c.toUpperCase())}`
    : row.credit_name || 'a creator');
const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);

/** One definition row (with its kind's name) → what its page shows, as search-feed's document description. */
function describe(row) {
    const rarity = RARITY_LABEL[row.rarity] || row.rarity;
    const kind = String(row.kind_name || row.kind);
    const fromQuest = listOf(row.grantors).includes('service:quest');
    const wearable = listOf(row.kind_slots).length > 0;
    return {
        listed: row.status === 'published' || row.status === 'retired',
        noindex: row.status === 'retired',
        title: `${row.name} · ${rarity} ${kind.toLowerCase()}`,
        summary: row.description || `${row.name}, a ${rarity.toLowerCase()} ${kind.toLowerCase()} on OpenVibe.`,
        body: [row.name, `${rarity} ${kind}`, row.description, wearable ? 'Wearable' : 'Collectible', `Given by ${issuerName(row)}`,
            fromQuest ? 'Earn it on OpenVibe.Quest: the reward for one of the quests there.' : ''].filter(Boolean).join('\n'),
        facets: { kind: row.kind, rarity: row.rarity, issuer: row.issuer, wearable },
        authorship: { mode: 'human' },
        publishedAt: row.published_at || row.created_at,
        updatedAt: row.updated_at,
    };
}

function createSearchIndex({ config, s, outbox, log = console }) {
    const feed = createSearchFeed({
        owner: 'inventory', db: s.db, outbox, baseUrl: config.baseUrl, now: s.now, log,
        types: {
            definition: {
                page: (row) => `/items/${row.id}`,
                document: describe,
                rows: (after, limit) => s.db.many(`${SELECT} WHERE d.id > $1 ORDER BY d.id LIMIT $2`, [after, limit]),
                exists: async (ids) => (await s.db.many('SELECT id FROM inventory_definitions WHERE id = ANY($1)', [ids])).map((r) => r.id),
            },
        },
    });
    const pending = new Set();
    const timers = [];
    let flushTimer = null;
    let flushing = null;

    async function syncId(id) {
        return await s.db.tx(async (t) => {
            const row = await t.maybe(`${SELECT} WHERE d.id = $1`, [id]);
            return row ? await feed.sync(t, 'definition', row) : await feed.remove(t, 'definition', id);
        });
    }

    async function flush() {
        flushTimer = null;
        if (flushing) await flushing;
        const ids = [...pending];
        pending.clear();
        flushing = (async () => {
            for (const id of ids) {
                try { await syncId(id); } catch (err) { log.warn(`[Search] item ${id}: ${(err && err.message) || err}`); }
            }
            if (ids.length && outbox.kick) outbox.kick().catch(() => {});
        })();
        try { await flushing; } finally { flushing = null; }
    }

    /** A write changed this definition: sync it shortly (never awaited by the request, never fatal). */
    function touch(id) {
        if (!id) return;
        pending.add(String(id));
        if (!flushTimer) {
            flushTimer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS);
            if (flushTimer.unref) flushTimer.unref();
        }
    }

    async function sweep() {
        const res = await feed.sweep();
        const d = res.definition;
        if (d.sent || d.removed || d.failed) log.log(`[Search] items: ${d.sent} sent, ${d.removed} removed, ${d.failed} failed of ${d.seen}`);
        if (outbox.kick) outbox.kick().catch(() => {});
        return res;
    }
    const quietly = () => { sweep().catch((err) => log.warn(`[Search] sweep failed: ${(err && err.message) || err}`)); };

    /** The outbox is Inventory's own: started and stopped by server/index.js, not here. */
    function start() {
        if (timers.length) return false;
        const kick = setTimeout(quietly, START_DELAY_MS);
        if (kick.unref) kick.unref();
        const tick = setInterval(quietly, INTERVAL_MS);
        if (tick.unref) tick.unref();
        timers.push(kick, tick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    }

    async function settle() {
        if (flushTimer) { clearTimeout(flushTimer); await flush(); }
        if (flushing) await flushing;
    }

    /**
     * Wrap the inventory's definition writes so each names what it changed. → the same object, for chaining. A write
     * answers { …definition } or { definition, … }; anything else names nothing.
     */
    function watch(inv) {
        for (const m of ['createDefinition', 'updateDefinition', 'updateWorkshopItem', 'review', 'takedown']) {
            const fn = inv[m];
            if (typeof fn !== 'function') continue;
            inv[m] = async (...args) => {
                const out = await fn(...args);
                const id = out && (out.definition ? out.definition.id : out.id);
                if (id) touch(id);
                return out;
            };
        }
        return inv;
    }

    return { feed, describe, touch, syncId, sweep, settle, start, stop, watch };
}

module.exports = { createSearchIndex, describe };
