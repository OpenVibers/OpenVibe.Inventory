'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { urls } = require('../server/urls');
const { DEF_RE } = require('../server/inventory/store');
const cookieHeader = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
(async () => {
    const t = await boot({ env: { PUBLIC_URL: 'https://openvibe.my/inventory', INVENTORY_REDIRECT_LEGACY: 'true' } });
    const user = t.network.addUser('inventory-owner');
    const defs = await t.ctx.inv.listDefinitions({ limit: 2 });
    const id = defs[0].id;
    await check('item IDs cannot collide with reserved routes', async () => {
        assert.ok(DEF_RE.test(id));
        for (const word of ['all', 'workshop', 'u', 'updates', 'auth', 'api']) assert.ok(!DEF_RE.test(word));
    });
    await check('all page links, assets and form actions stay in Inventory', async () => {
        for (const [path, as] of [
            ['/inventory'], ['/inventory/all'], ['/inventory/all?kind=live.hat'], [`/inventory/${id}`],
            ['/inventory/workshop'], ['/inventory/updates'], ['/inventory/terms'], ['/inventory/privacy'], ['/inventory', user],
            ['/inventory/workshop/new', user], ['/inventory/workshop/mine', user],
            ['/inventory/workshop/review', { ...user, role: 'admin' }], [`/inventory/u/${user.subject}`],
            ['/inventory/missing'],
        ]) {
            const r = await t.get(path, { as });
            assert.strictEqual(r.status, path === '/inventory/missing' ? 404 : 200, path);
            const links = [...r.text.matchAll(/\b(?:href|src|action)=["'](\/(?!\/)[^"']*)["']/g)].map((m) => m[1]);
            assert.ok(links.length, path);
            assert.deepStrictEqual(links.filter((s) => !/^\/inventory(?:[/?#]|$)/.test(s)), [], path);
            assert.ok(!r.text.includes('/inventory/inventory'), 'no double prefix');
            assert.ok(r.text.includes(`rel=\"canonical\" href=\"https://openvibe.my${path.split('?')[0]}\"`), path + ': canonical');
            assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: https:;/);
            if (path === '/inventory' && as) assert.match(r.text, /<h1>Your inventory<\/h1>/);
        }
        const asset = await t.get('/inventory/css/app.css');
        assert.strictEqual(asset.status, 200);
        const sitemap = await t.get('/inventory/sitemap.xml');
        assert.ok(sitemap.text.includes('https://openvibe.my/inventory/all'));
        assert.ok(sitemap.text.includes(`https://openvibe.my/inventory/${id}`));
        assert.ok(!sitemap.text.includes('/items'));
        const markdown = await t.get('/inventory/all.md');
        assert.strictEqual(markdown.status, 200);
        assert.ok(markdown.text.includes('canonical: \"https://openvibe.my/inventory/all\"'));
        assert.strictEqual((await t.get('/inventory.md')).status, 200);
        for (const path of ['/inventory/internal/events', '/inventory/metrics']) assert.strictEqual((await t.get(path)).status, 404);
    });
    await check('legacy page 301 table preserves queries; machine endpoints stay', async () => {
        for (const [from, to] of [['/', ''], ['/items', '/all'], [`/items/${id}`, `/${id}`], ['/me', ''],
            ['/workshop', '/workshop'], ['/workshop/new', '/workshop/new'], [`/u/${user.subject}`, `/u/${user.subject}`], ['/updates', '/updates']]) {
            const r = await t.get(`${from}?keep=1`);
            assert.strictEqual(r.status, 301, from);
            assert.strictEqual(r.headers.get('location'), `https://openvibe.my/inventory${to}?keep=1`);
        }
        for (const path of ['/api/v1/kinds', '/.well-known/agent.json', '/auth/me', '/health', '/metrics', '/mcp', '/feed.xml', '/feed.json']) {
            assert.notStrictEqual((await t.get(path)).status, 301, path);
        }
    });
    await check('browser entry silently checks Network without third-party cookies', async () => {
        const r = await t.get('/inventory', { headers: { accept: 'text/html' } });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.get('location'), '/inventory/auth/login?silent=1&next=%2Finventory');
        assert.strictEqual((await t.get('/inventory?sso=none', { headers: { accept: 'text/html' } })).status, 200);
        assert.strictEqual((await t.get('/inventory', { cookie: 'inventory_ov_sso_hint=guest', headers: { accept: 'text/html' } })).status, 200);
    });
    await check('silent PKCE callback uses isolated host-only Inventory cookies', async () => {
        const hub = `ov_token=${t.network.userToken(user)}; ov_refresh=hub-refresh; ov_oauth_state=hub-state`;
        assert.strictEqual((await t.get('/inventory/auth/me', { cookie: hub })).json().user, null, 'hub session is not an Inventory session');
        const login = await t.get('/inventory/auth/login?silent=1&next=' + encodeURIComponent('https://openvibe.my/inventory'), { cookie: hub });
        const loc = new URL(login.headers.get('location'));
        assert.strictEqual(loc.searchParams.get('prompt'), 'none');
        assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://openvibe.my/inventory/auth/callback');
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const callback = await t.get(`/inventory/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: `${hub}; ${cookieHeader(login)}` });
        assert.strictEqual(callback.status, 302, callback.text);
        assert.strictEqual(callback.headers.get('location'), '/inventory');
        for (const r of [login, callback]) for (const c of r.headers.getSetCookie()) {
            assert.match(c, /; Path=\/inventory(?:;|$)/);
            assert.ok(!/; Domain=/i.test(c));
            assert.ok(!/^ov_(?:token|refresh|oauth_)/.test(c), 'never write hub cookie names');
        }
        const session = cookieHeader(callback);
        assert.strictEqual((await t.get('/inventory/auth/me', { cookie: `${hub}; ${session}` })).json().user.username, user.username);
        assert.match((await t.get('/inventory', { cookie: session })).text, /<h1>Your inventory<\/h1>/);
        const logout = await t.get('/inventory/auth/logout', { cookie: session, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(logout.headers.get('location'), '/inventory');
        for (const c of logout.headers.getSetCookie()) assert.match(c, /; Path=\/inventory(?:;|$)/);
        const guest = await t.get(`/inventory/auth/callback?error=login_required`, { cookie: cookieHeader(login) });
        assert.match(guest.headers.get('location'), /^\/inventory\?sso=none$/);
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
