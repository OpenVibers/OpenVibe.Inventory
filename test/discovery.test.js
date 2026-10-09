'use strict';
/**
 * The public crawl artifacts (plan T11), fetched from the booted app: /robots.txt, /sitemap.xml,
 * /llms.txt, /llms-full.txt and the home page's JSON-LD. Each is served with the right status and
 * content type, carries at least one real entry, lists public pages only, and takes lastmod from the
 * site's own data (STATUS.json) — never from the clock.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;
// llms.txt names the public machine endpoints on purpose, so only sign-in and the API are private there.
const PRIVATE = ['/auth/', '/api/'];

(async () => {
    const t = await boot();
    try {
        await check('robots.txt: 200 text/plain, sign-in and the API disallowed, the public pages crawlable, sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of ['/auth/', '/api/']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            for (const d of ['/updates']) assert.ok(!r.text.includes(`Disallow: ${d}`), `${d} must stay crawlable`);
            assert.ok(r.text.includes('Sitemap: https://inventory.openvibe.network/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text), 'no User-agent: * group');
        });

        await check('sitemap.xml: 200 application/xml, real entries, lastmod from the data', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const p of ['/', '/updates']) assert.ok(r.text.includes(`<loc>https://inventory.openvibe.network${p}</loc>`), `no ${p} entry`);
            // The catalog: /items, each kind with items, and every published item.
            assert.ok(r.text.includes('<loc>https://inventory.openvibe.network/items</loc>'), 'no /items entry');
            // This kind's URL has no '&', so it must appear exactly, unescaped — and with no stray '&amp;'.
            assert.ok(r.text.includes('<loc>https://inventory.openvibe.network/items?kind=live.hat</loc>'), 'no /items?kind=live.hat entry');
            assert.ok(!r.text.includes('items?kind=live.hat&amp;'), 'that URL must not gain an entity');
            const items = [...r.text.matchAll(/<loc>https:\/\/inventory\.openvibe\.network\/items\/itd_/g)];
            assert.strictEqual(items.length, 70, `expected 70 item entries, got ${items.length}`);
            for (const p of ['/me', '/u/', '/api/']) assert.ok(!r.text.includes(`<loc>https://inventory.openvibe.network${p}`), `private path in sitemap: ${p}`);
            for (const p of ['/auth/login', '/api/v1/ping']) assert.ok(!r.text.includes(`<loc>https://inventory.openvibe.network${p}</loc>`), `${p} is not a public page`);
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0, 'no lastmod anywhere');
            assert.ok(lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `bad lastmod: ${lastmods.slice(0, 3)}`);
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED}), got ${[...new Set(lastmods)].join(', ')}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://inventory.openvibe.network${p}`), `private path in sitemap: ${p}`);
        });

        await check('llms.txt: 200 text/plain, real links, nothing private', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Inventory'), 'no title');
            assert.ok(r.text.includes('(https://inventory.openvibe.network/updates)'), 'no updates link');
            assert.ok(r.text.includes('(https://openvibe.services)'), 'no pointer to the developer platform');
            assert.ok(r.text.includes('https://inventory.openvibe.network/sitemap.xml'), 'sitemap not listed');
            assert.ok(r.text.includes('(https://inventory.openvibe.network/llms-full.txt)'), 'llms-full.txt not listed');
            // The catalog and the public read API are named for language models on purpose.
            assert.ok(r.text.includes('(https://inventory.openvibe.network/items)'), 'no /items link');
            assert.ok(r.text.includes('https://inventory.openvibe.network/items?kind=live.hat'), 'no kind link');
            assert.ok(r.text.includes('GET /api/v1/kinds'), 'the API section is missing');
            for (const p of ['/auth/']) assert.ok(!r.text.includes(`https://inventory.openvibe.network${p}`), `private path in llms.txt: ${p}`);
        });

        await check('llms-full.txt: 200 text/plain, the site title, and every page the sitemap lists', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Inventory'), 'no title');
            const sitemap = await t.get('/sitemap.xml');
            const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            assert.ok(locs.length >= 2, `sitemap too small: ${locs.length}`);
            for (const loc of locs) assert.ok(r.text.includes(loc), `llms-full.txt is missing ${loc}`);
            assert.ok(r.text.includes('URL: https://inventory.openvibe.network/updates\n'), 'no /updates entry');
            // Every published item: its name, rarity, kind and URL, grouped by kind.
            assert.ok(r.text.includes('Royal Crown'), 'no item names');
            assert.ok(/### Royal Crown\n\nURL: https:\/\/inventory\.openvibe\.network\/items\/itd_[0-9A-HJKMNP-TV-Z]{26}\n/.test(r.text), 'no Royal Crown item line');
            assert.ok(r.text.includes('\n## Hat\n'), 'items are not grouped by kind');
            assert.ok(r.text.includes('Epic Hat'), 'the item line lacks its rarity and kind');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://inventory.openvibe.network${p}`), `private path in llms-full.txt: ${p}`);
        });

        await check('home page: WebSite + the site\'s primary type, the same for every crawler', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const types = blocks.map((b) => b['@type']);
            assert.ok(types.includes('WebSite'), `no WebSite node: ${types}`);
            assert.ok(types.includes('WebApplication'), `no primary-type node: ${types}`);
            const site = blocks.find((b) => b['@type'] === 'WebSite');
            assert.strictEqual(site.url, 'https://inventory.openvibe.network');
            assert.strictEqual(site.name, 'OpenVibe.Inventory');
            const page = blocks.find((b) => b['@type'] === 'WebPage');
            assert.strictEqual(page.url, 'https://inventory.openvibe.network/');
        });
    } finally { await t.close(); }
    done();
})();
