'use strict';

/**
 * Pages (ADR-054). Every page works without JavaScript and is server-rendered through openvibe-shared/shell.
 *
 *   /                 what the inventory is, its kinds, a few items, how items arrive
 *   /items            every published item, by kind (?kind=), with its rarity
 *   /items/:id        one item: what it is, where it shows, who issues it, how many exist
 *   /me               the signed-in person's items; equip or take off with plain forms (POST /me/equip)
 *   /u/:subject       a person's public inventory and what they wear
 *   /updates          the update log
 *
 * Nothing here sells, buys, trades or converts an item (ADR-054 §5).
 */
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const express = require('express');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const { InventoryError, SUBJECT_RE, RARITY } = require('../inventory/store');

const SITE_NAME = 'OpenVibe.Inventory';
const TAGLINE = 'Your items, on every OpenVibe site.';
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const SURFACE_LABEL = { chat: 'chat', overlay: 'stream overlays', profile: 'your profile' };
// The ring icon each kind's card shows on the home page (openvibe-shared ov-icons); another kind gets the generic one.
const KIND_ICON = { 'live.name_effect': 'ov:text', 'live.particle': 'ov:theme', 'live.hat': 'ov:account', 'live.voice': 'ov:audio', 'live.chat_tag': 'ov:chat' };
const surfaceLabel = (s) => SURFACE_LABEL[s] || (s.startsWith('game:') ? `the game ${s.slice(5)}` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The item's picture: its emoji, or a Media image, in a square tile tinted by rarity. */
function art(d, { size = 'md' } = {}) {
    const a = d.art || {};
    if (a.media_id) return html`<span class="inv-art inv-art-${size} r-${d.rarity}"><img src="https://openvibe.media/o/${a.media_id}" alt="" loading="lazy" width="64" height="64"></span>`;
    return html`<span class="inv-art inv-art-${size} r-${d.rarity}" aria-hidden="true">${a.emoji || '◆'}</span>`;
}
const rarityBadge = (r) => html`<span class="inv-rarity r-${r}">${RARITY_LABEL[r] || r}</span>`;

function card(d, { href = `/items/${d.id}`, extra = '', owned = null, worn = false } = {}) {
    return html`<li class="inv-card r-${d.rarity}${worn ? ' is-worn' : ''}">
  <a class="inv-card-link" href="${href}">${art(d)}<span class="inv-card-body"><span class="inv-card-name">${d.name}</span>${rarityBadge(d.rarity)}</span></a>
  ${d.description ? html`<p class="inv-card-desc">${d.description}</p>` : ''}${owned ? html`<p class="inv-card-meta">${owned}</p>` : ''}${extra}
</li>`;
}

function createPageRoutes(ctx) {
    const { config, inv } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => (req.viewer && req.viewer.kind === 'user' && SUBJECT_RE.test(String(req.viewer.subject || '')) ? req.viewer.subject : null);
    const notFound = (req, res, what) => page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>${what} <a href="/items">Browse every item</a>.</p>` }, 404);

    async function catalog() {
        const [kinds, defs] = await Promise.all([inv.listKinds(), inv.listDefinitions({ limit: 500 })]);
        const byKind = new Map(kinds.map((k) => [k.id, []]));
        for (const d of defs) if (byKind.has(d.kind)) byKind.get(d.kind).push(d);
        const order = (a, b) => RARITY.indexOf(b.rarity) - RARITY.indexOf(a.rarity) || a.name.localeCompare(b.name);
        for (const list of byKind.values()) list.sort(order);
        return { kinds, defs, byKind };
    }

    // ── Home ─────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const { kinds, defs, byKind } = await catalog();
        const featured = [...defs].sort((a, b) => RARITY.indexOf(b.rarity) - RARITY.indexOf(a.rarity) || a.name.localeCompare(b.name)).slice(0, 6);
        const me = signedIn(req);
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · part of OpenVibe`,
            title: 'Your items,',
            accent: 'on every OpenVibe site.',
            lede: 'One inventory for your whole OpenVibe account: name effects, particles, hats, voices and more. Earn them across the network, wear them in chat, on stream overlays and on your profile.',
            actions: me
                ? [{ label: 'Your inventory', href: '/me', primary: true }, { label: 'Browse every item', href: '/items' }]
                : [{ label: 'Browse every item', href: '/items', primary: true }, { label: 'Sign in to see yours', href: '/auth/login?next=%2Fme' }],
            note: 'Items are earned or given, never sold here. Open source (AGPL-3.0).',
            aside: { html: html`<div class="inv-hero-panel" aria-label="A few of the rarest items"><p class="inv-hero-title">From the collection</p><ul class="inv-hero-grid">${featured.map((d) => html`<li><a href="/items/${d.id}" title="${d.name} · ${RARITY_LABEL[d.rarity]}">${art(d, { size: 'lg' })}<span class="inv-hero-name">${d.name}</span></a></li>`)}</ul></div>`.toString() },
        });
        page(req, res, {
            index: true, cache: me ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
${raw(showcase.features({
                title: 'What you can collect',
                lede: `${plural(defs.length, 'item', 'items')} in ${plural(kinds.length, 'kind', 'kinds')} today. Each kind knows where it shows, so a new kind is all it takes for a new site or game to join.`,
                // Kinds that have items, the biggest first; an empty kind waits until an issuer defines something in it.
                items: kinds.filter((k) => (byKind.get(k.id) || []).length).sort((a, b) => byKind.get(b.id).length - byKind.get(a.id).length).map((k) => ({ icon: KIND_ICON[k.id] || 'ov:ov', title: `${k.name} · ${(byKind.get(k.id) || []).length}`, text: `${k.description || ''} Shows in ${k.surfaces.map((s) => surfaceLabel(s.surface)).join(', ')}.`, href: `/items?kind=${encodeURIComponent(k.id)}` })),
            }))}
${raw(showcase.steps({
                title: 'How items reach you',
                items: [
                    { title: 'Earn or receive them', text: 'Sites, games and quests across the network give items for what you do. Each one can only give its own items.' },
                    { title: 'Keep them in one place', text: 'Everything you own is here, with where it came from and when.' },
                    { title: 'Wear them everywhere', text: 'Equip one item per slot. Every site that shows that kind shows what you chose.' },
                    { title: 'Never for sale', text: 'Nothing here is bought, sold, traded or turned into money. Rarity is shown as it is.' },
                ],
            }))}
${raw(showcase.cta({ title: me ? 'See what you have' : 'Already earned something?', text: me ? 'Your items and what you are wearing, on one page.' : 'Sign in with your OpenVibe account to see your inventory and choose what to wear.', actions: me ? [{ label: 'Your inventory', href: '/me' }] : [{ label: 'Sign in with OpenVibe', href: '/auth/login?next=%2Fme' }, { label: 'The API', href: '/api/v1/kinds' }] }))}`,
        });
    });

    // ── The catalog ──────────────────────────────────────────
    r.get('/items', async (req, res) => {
        const { kinds, defs, byKind } = await catalog();
        const only = req.query.kind ? String(req.query.kind) : null;
        if (only && !byKind.has(only)) return notFound(req, res, 'There is no such kind of item.');
        // All: the kinds that have items; one kind: that kind, even while it is empty.
        const shown = kinds.filter((k) => (only ? k.id === only : (byKind.get(k.id) || []).length));
        page(req, res, {
            index: !only, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: only ? `${shown[0].name} items` : 'Every item',
            description: `${plural(defs.length, 'item', 'items')} you can earn and wear across OpenVibe, with their rarity.`,
            body: html`<h1>${only ? `${shown[0].name} items` : 'Every item'}</h1>
<p class="lede">${only ? shown[0].description : `${plural(defs.length, 'item', 'items')} in ${plural(kinds.length, 'kind', 'kinds')}. Rarity is shown as it is.`}</p>
<nav class="inv-tabs" aria-label="Kinds"><a href="/items"${only ? '' : raw(' aria-current="page"')}>All</a>${kinds.map((k) => html`<a href="/items?kind=${encodeURIComponent(k.id)}"${only === k.id ? raw(' aria-current="page"') : ''}>${k.name} <span class="muted">${(byKind.get(k.id) || []).length}</span></a>`)}</nav>
${shown.map((k) => html`<section class="inv-kind" aria-labelledby="k-${k.id.replace(/\W/g, '-')}">
  <h2 id="k-${k.id.replace(/\W/g, '-')}">${k.name} <span class="muted small">shows in ${k.surfaces.map((s) => surfaceLabel(s.surface)).join(', ')}</span></h2>
  ${(byKind.get(k.id) || []).length ? html`<ul class="inv-grid">${byKind.get(k.id).map((d) => card(d))}</ul>` : html`<p class="muted">No ${k.name.toLowerCase()} items yet.</p>`}
</section>`)}`,
        });
    });

    r.get('/items/:id', async (req, res) => {
        const d = await inv.getDefinition(req.params.id);
        if (!d || (d.status !== 'published' && d.status !== 'retired')) return notFound(req, res, 'There is no such item.');
        const k = await inv.getKind(d.kind);
        const issuer = d.issuer.startsWith('service:') ? `OpenVibe.${d.issuer.slice(8).replace(/^./, (c) => c.toUpperCase())}` : d.credit && d.credit.name ? d.credit.name : 'a creator';
        page(req, res, {
            index: d.status === 'published', cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: `${d.name} · ${RARITY_LABEL[d.rarity]} ${k.name.toLowerCase()}`,
            description: d.description || `${d.name}, a ${RARITY_LABEL[d.rarity].toLowerCase()} ${k.name.toLowerCase()} on OpenVibe.`,
            body: html`<p class="crumbs"><a href="/items">Every item</a> › <a href="/items?kind=${encodeURIComponent(k.id)}">${k.name}</a></p>
<div class="inv-detail r-${d.rarity}">
  ${art(d, { size: 'xl' })}
  <div>
    <h1>${d.name}</h1>
    <p>${rarityBadge(d.rarity)} <span class="muted">${k.name}</span>${d.status === 'retired' ? html` <span class="badge warn">No longer given</span>` : ''}</p>
    ${d.description ? html`<p class="lede">${d.description}</p>` : ''}
  </div>
</div>
<ul class="stats">
  <li><b>${d.supply.issued}</b> owned across OpenVibe</li>
  <li><b>${d.supply.cap == null ? 'Unlimited' : `${d.supply.cap - d.supply.issued} of ${d.supply.cap}`}</b> ${d.supply.cap == null ? 'supply' : 'left'}</li>
  <li><b>${k.slots.length ? 'Wearable' : 'Collectible'}</b> ${k.slots.length ? `in the ${k.slots.join(', ')} slot` : 'shown on your profile'}</li>
</ul>
${(d.grantors || []).includes('service:quest') && d.status === 'published' ? html`<h2>How to get it</h2>
<p>Earn it on <a href="https://openvibe.quest/">OpenVibe.Quest</a>: it is the reward for one of the quests there, given once to everyone who completes it.</p>` : ''}
<h2>Where it shows</h2>
<p>${k.surfaces.map((s) => surfaceLabel(s.surface)).join(', ').replace(/^./, (c) => c.toUpperCase())}.</p>
<h2>Who gives it</h2>
<p>${issuer}. Only its issuer can give this item; it is never sold here.</p>
<p class="muted small">Item <code>${d.id}</code>${(d.aliases || []).length ? html` · also known as <code>${d.aliases.join(', ')}</code>` : ''} · <a href="/api/v1/definitions/${d.id}">JSON</a></p>`,
        });
    });

    // ── Your inventory ───────────────────────────────────────
    async function ownedView(subject, { own }) {
        const [list, eq, kinds] = await Promise.all([inv.inventory(subject, { own, limit: 200 }), inv.equipped([subject]), inv.listKinds()]);
        const worn = new Set(Object.values(eq[0] ? eq[0].slots : {}).map((x) => x.instance_id));
        const owned = list.instances.filter((i) => i.state === 'owned');
        const byKind = new Map(kinds.map((k) => [k.id, []]));
        for (const i of owned) { const d = list.definitions[i.definition_id]; if (d && byKind.has(d.kind)) byKind.get(d.kind).push({ i, d }); }
        return { kinds, byKind, worn, owned, more: !!list.next_cursor };
    }

    r.get('/me', async (req, res) => {
        const me = signedIn(req);
        if (!me) return res.redirect(303, '/auth/login?next=%2Fme');
        const { kinds, byKind, worn, owned, more } = await ownedView(me, { own: true });
        const done = req.query.done ? String(req.query.done) : null;
        const error = req.query.error ? String(req.query.error).slice(0, 200) : null;
        page(req, res, {
            title: 'Your inventory',
            body: html`<h1>Your inventory</h1>
<p class="lede">${owned.length ? `${plural(owned.length, 'item', 'items')}. Choose one per slot to wear it on every site that shows it.` : 'Nothing yet. Items arrive as you take part across OpenVibe: streams, quests, games and events.'}</p>
${done ? html`<p class="notice ok" role="status">${done === 'equipped' ? 'Equipped. It shows everywhere that kind is shown.' : 'Taken off.'}</p>` : ''}
${error ? html`<p class="notice bad" role="alert">${error}</p>` : ''}
<p><a href="/u/${me}">See your public page</a> · <a href="/items">Browse every item</a></p>
${kinds.filter((k) => byKind.get(k.id).length).map((k) => html`<section class="inv-kind">
  <h2>${k.name} <span class="muted small">${plural(byKind.get(k.id).length, 'item', 'items')}</span></h2>
  <ul class="inv-grid">${byKind.get(k.id).map(({ i, d }) => card(d, {
        owned: `Since ${String(i.acquired_at).slice(0, 10)}${i.serial ? ` · #${i.serial}` : ''}`,
        worn: worn.has(i.id),
        extra: k.slots.length ? html`<form method="post" action="/me/equip" class="inv-equip">
      <input type="hidden" name="kind" value="${k.id}"><input type="hidden" name="slot" value="${k.slots[0]}">
      ${worn.has(i.id)
        ? html`<input type="hidden" name="instance_id" value=""><span class="inv-worn">Wearing</span><button type="submit" class="inv-btn">Take off</button>`
        : html`<input type="hidden" name="instance_id" value="${i.id}"><button type="submit" class="inv-btn primary" aria-label="Wear ${d.name}">Wear</button>`}
    </form>` : '',
    }))}</ul>
</section>`)}
${more ? html`<p class="muted">Showing the newest 200. The full list is at <a href="/api/v1/me/items">/api/v1/me/items</a>.</p>` : ''}`,
        });
    });

    r.post('/me/equip', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        const me = signedIn(req);
        if (!me) return res.redirect(303, '/auth/login?next=%2Fme');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('That form must come from this site.');
        const b = req.body || {};
        try {
            await inv.equip(me, `user:${me}`, { kind: String(b.kind || ''), slot: String(b.slot || ''), instance_id: b.instance_id ? String(b.instance_id) : null });
            return res.redirect(303, `/me?done=${b.instance_id ? 'equipped' : 'cleared'}`);
        } catch (err) {
            if (err instanceof InventoryError) return res.redirect(303, `/me?error=${encodeURIComponent(err.detail || err.code)}`);
            throw err;
        }
    });

    // ── A person's public page ───────────────────────────────
    r.get('/u/:subject', async (req, res) => {
        const subject = String(req.params.subject);
        if (!SUBJECT_RE.test(subject)) return notFound(req, res, 'There is no such person.');
        const { kinds, byKind, worn, owned } = await ownedView(subject, { own: false });
        const mine = signedIn(req) === subject;
        const wornItems = owned.filter((i) => worn.has(i.id));
        page(req, res, {
            index: false, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: mine ? 'Your public inventory' : 'An OpenVibe inventory',
            body: html`<h1>${mine ? 'Your public inventory' : 'An OpenVibe inventory'}</h1>
<p class="lede">${plural(owned.length, 'item', 'items')}${wornItems.length ? `, ${wornItems.length} worn` : ''}.${mine ? ' This is what anyone sees.' : ''}</p>
${kinds.filter((k) => byKind.get(k.id).length).map((k) => html`<section class="inv-kind"><h2>${k.name}</h2>
  <ul class="inv-grid">${byKind.get(k.id).map(({ i, d }) => card(d, { worn: worn.has(i.id), extra: worn.has(i.id) ? html`<p class="inv-worn">Wearing</p>` : '' }))}</ul></section>`)}
${!owned.length ? html`<p class="muted">Nothing to show yet.</p>` : ''}`,
        });
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'inventory', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
