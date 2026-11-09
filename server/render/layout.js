'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript:
 *   - <head>: title, description, canonical, robots (pages are noindex unless they say otherwise), Open Graph/Twitter,
 *     JSON-LD (openvibe-shared/seo), plus this service's extras: the shared app icon, the stylesheet, the boost marker
 *   - the OpenVibe Frame: theme-loader, web-runtime, navbar and footer scripts (the shell boots the
 *     navbar; the footer is initialised below), a <noscript> navigation bar and the server-rendered footer
 *   - the product's own script only where a page offers an in-browser convenience
 */
const crypto = require('crypto');
const { urls } = require('../urls');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Inventory';
const TAGLINE = 'Your items, on every OpenVibe site.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// The product's own places: the main ones carry an icon (phones get them as the bottom tab bar), the rest fold into
// the navbar's More (Shared 4.22). Search is the navbar's magnifier and What shipped is the footer's.
const NAV = [
    { label: 'Every item', href: '/items', icon: 'fa-tag' },
    { label: 'Your inventory', href: '/me', icon: 'fa-shirt' },
    { label: 'Workshop', href: '/workshop', icon: 'fa-screwdriver-wrench' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (html), viewer, config, path, index (default false), scripts [rel],
 *    crumbs [{ label, href }], jsonLd [nodes] (serialised by openvibe-shared/seo), styles [openvibe-shared stylesheet names]
 */
function renderPage(o) {
    const { path: url, absolute, html: sharedHtml } = urls(o.config);
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = absolute(pathNow.split('?')[0]);
    const nav = {
        service: 'inventory',
        ...(urls(o.config).prefix ? { brand: { href: url('/'), tld: 'inventory', name: 'Inventory' } } : {}),
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: url(l.href), ...(l.icon ? { icon: l.icon } : {}), ...(l.more ? { more: true } : {}), active: pathNow === url(l.href) || pathNow.startsWith(`${url(l.href)}/`) })),
        // On openvibe.my, Inventory is a section of the account hub: the first tab goes to the hub, and "Yours" is this
        // section's home (/inventory), so two tabs never light up for the same page.
        appBar: urls(o.config).prefix
            ? [{ label: 'My', href: new URL('/', absolute('/')).href, icon: 'fa-house' }, { label: 'Yours', href: url('/me'), icon: 'fa-shirt' }, { label: 'Items', href: url('/items'), icon: 'fa-tag' }, { label: 'Workshop', href: url('/workshop'), icon: 'fa-screwdriver-wrench' }]
            : [{ label: 'Home', href: url('/'), icon: 'fa-house' }, { label: 'Items', href: url('/items'), icon: 'fa-tag' }, { label: 'Yours', href: url('/me'), icon: 'fa-shirt' }, { label: 'Workshop', href: url('/workshop'), icon: 'fa-screwdriver-wrench' }],   // phones: the bottom tab bar (Shared 4.20)
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: urls(o.config).prefix ? null : absolute('/auth/login') + '?silent=1&next={url}',
        sessionUrl: url('/auth/me'),
        tokenUrl: url('/auth/navbar-token'),
        fedcmLogin: url('/auth/fedcm'),
        loginUrl: url('/auth/login?next={path}'),           // filled from the current page (boost moves between pages)
        logoutUrl: url('/auth/logout?next={path}'),   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    const footer = { service: 'inventory', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: url('/updates'), ...(urls(o.config).prefix ? { sitemap: url('/sitemap.xml'), legalBase: absolute('/') } : {}) };
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="${url(`/auth/logout?next=${loginNext}`)}">Sign out</a>`
        : html`<a href="${url(`/auth/login?next=${loginNext}`)}">Sign in with OpenVibe</a>`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${url(c.href)}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const scripts = (o.scripts || []).map((rel) => html`<script src="${url(asset(rel))}" defer></script>`);
    return sharedHtml(shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME} — ${TAGLINE}`,
        canonical,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        // A page with a Markdown twin (o.agent) advertises it in the head and the Link header; the twin itself
        // is server/agent-pages.js.
        agentLayer: o.agent === true,
        llms: absolute('/llms.txt'),
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: url('/'),
        navLinks: NAV.map((l) => ({ ...l, href: url(l.href) })),
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${sharedHtml(appIcon.headTags({ site: 'inventory' }))}
<link rel="stylesheet" href="${url(asset('css/app.css'))}">
${(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(url(ovServe.url(name)))}">`).join('\n')}
${render(scripts)}
<meta name="ov-boost" content="inventory@${esc(RELEASE)}">
<script src="${url(ovServe.url('boost.js'))}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page">
${render(crumbs)}
${render(o.body)}
${o.path === '/' ? sharedHtml(frame.shipped({ service: 'inventory', title: `Recently shipped on ${SITE_NAME}` })) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
${urls(o.config).prefix ? `  // Shared 4.150 hardcodes the footer brand's home and rerenders it after loading
  // Frame data. Keep that link inside this section on each render.
  var footer = document.getElementById('ov-footer');
  var home = ${JSON.stringify(url('/'))};
  if (footer && home !== '/') {
    var fixHome = function () { footer.querySelectorAll('a.ovf-brand').forEach(function (a) { if (a.getAttribute('href') !== home) a.setAttribute('href', home); }); };
    fixHome();
    new MutationObserver(fixHome).observe(footer, { childList: true, subtree: true });
  }` : ''}
});
</script>`,
    }));
}

function render(v) { return require('./html').render(v); }

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    // A page rendered for a signed-in person names them in the account bar: never shared caches.
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', !personal && o.cache ? o.cache : cache.htmlHeaders({ private: true }));
    res.set('Vary', 'Cookie');
    if (o.agent) {
        res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(urls(o.config).absolute(String(o.path || '/').split('?')[0]), urls(o.config).absolute('/llms.txt')).header);
    }
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, NAV, raw, html };
