'use strict';

/**
 * Crawl artifacts for inventory.openvibe.network, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in and
 * the API are not.
 *
 * The product extends PAGE_TEXT and publicPages() with its own pages; the routes and headers here stay. The catalog is
 * read through ctx.inv: the sitemap lists /items, a page per kind with items and every published item; llms.txt maps the
 * kinds and the public read API; llms-full.txt spells out every item. seo.sitemapXml escapes each loc ('&' → '&amp;').
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Inventory';
const DESCRIPTION = 'OpenVibe.Inventory — Your items, on every OpenVibe site.';
const DISALLOW = ['/auth/', '/api/'];
// The two routes that need a subject point at the API reference, not at a URL that answers 400.
const API_DOC = 'https://github.com/OpenVibers/OpenVibe.Inventory#api-apiv1-problemjson-errors';
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

const PAGE_TEXT = {
    '/': ['OpenVibe.Inventory home', 'OpenVibe.Inventory: Your items, on every OpenVibe site.'],
    '/updates': ['What shipped on OpenVibe.Inventory', 'This site\'s update log, from the network changelog feed.'],
    '/items': ['Every item', 'Every published item on OpenVibe.Inventory, by kind, with its rarity.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'openvibe' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
];

const CATALOG_PAGE = { path: '/items', changefreq: 'daily', priority: 0.7 };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const kindPath = (id) => `/items?kind=${encodeURIComponent(id)}`;

/** The catalog read straight from ctx.inv: kinds, their published items, and the items grouped by kind. */
async function catalog(inv) {
    const [kinds, defs] = await Promise.all([inv.listKinds(), inv.listDefinitions({ limit: 500 })]);
    const byKind = new Map(kinds.map((k) => [k.id, []]));
    for (const d of defs) if (byKind.has(d.kind)) byKind.get(d.kind).push(d);
    return { kinds, defs, byKind };
}
const kindsWithItems = ({ kinds, byKind }) => kinds.filter((k) => byKind.get(k.id).length);

/** Every public URL: the static pages, /items, a page per kind with items, and each published item. */
function catalogPages({ kinds, defs, byKind }) {
    return [
        ...publicPages(),
        CATALOG_PAGE,
        ...kindsWithItems({ kinds, byKind }).map((k) => ({ path: kindPath(k.id), changefreq: 'weekly', priority: 0.6 })),
        ...defs.map((d) => ({ path: `/items/${d.id}`, changefreq: 'monthly', priority: 0.4 })),
    ];
}

function createDiscoveryRoutes(ctx) {
    const { config, inv } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# inventory.openvibe.network: the public pages are for search and AI crawlers; sign-in and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', async (_req, res) => {
        const { kinds, defs, byKind } = await catalog(inv);
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Inventory: Your items, on every OpenVibe site.',
            details: 'One inventory for an OpenVibe account: items earned or given by sites, games and apps, worn in chat, on '
                + 'stream overlays and on your profile. Nothing here is sold, bought, traded or converted. '
                + 'Every page is server-rendered and readable without JavaScript.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Inventory', url: abs('/'), note: 'Your items, on every OpenVibe site.' },
                    { title: 'What shipped on OpenVibe.Inventory', url: abs('/updates') },
                ] },
                { title: 'Browse the inventory', links: [
                    { title: 'Every item', url: abs('/items'), note: `${plural(defs.length, 'published item', 'published items')}` },
                    // Every kind, its own page and count; a kind with nothing in it yet shows 0.
                    ...kinds.map((k) => ({ title: k.name, url: abs(kindPath(k.id)), note: plural(byKind.get(k.id).length, 'item', 'items') })),
                ] },
                { title: 'API', links: [
                    { title: 'GET /api/v1/kinds', url: abs('/api/v1/kinds'), note: 'every item kind, with where it is worn and shown' },
                    { title: 'GET /api/v1/definitions', url: abs('/api/v1/definitions'), note: 'published items; filter with ?kind= or ?issuer=' },
                    { title: 'GET /api/v1/people/:subject/items', url: API_DOC, note: 'the items one person owns' },
                    { title: 'GET /api/v1/equipped?subjects=…', url: API_DOC, note: 'up to 100 equipped sets in one call' },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', async (_req, res) => {
        const { kinds, defs, byKind } = await catalog(inv);
        const pages = [...publicPages(), CATALOG_PAGE].map((e) => ({ url: e.path, title: PAGE_TEXT[e.path][0], text: PAGE_TEXT[e.path][1] }));
        // Every published item, one line each (name, rarity, kind and URL), grouped by kind.
        const itemSections = kindsWithItems({ kinds, byKind }).map((k) => {
            const items = byKind.get(k.id);
            pages.push({ url: kindPath(k.id), title: `${k.name} items`, text: `${plural(items.length, 'item', 'items')}, with their rarity.` });
            return { title: k.name, pages: items.map((d) => ({ title: d.name, url: `/items/${d.id}`, text: `${RARITY_LABEL[d.rarity] || d.rarity} ${k.name}` })) };
        });
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Inventory, one line each.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }, ...itemSections],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = siteUpdated();
        // seo.sitemapXml escapes every loc, so a query string's '&' comes out as '&amp;'.
        const urls = catalogPages(await catalog(inv)).map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
