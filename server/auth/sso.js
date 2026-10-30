'use strict';

/**
 * Sign-in with OpenVibe.Network, on openvibe-sdk/sso (0.73.0) instead of this site's own copy of the OAuth client.
 *
 * The SDK owns the flow: GET /auth/login (PKCE S256, ?next, ?silent, ?prompt, ?login_hint), GET /auth/callback
 * (recovering by itself once from a lost flow or a used code), GET /auth/logout, GET /auth/me, POST /auth/fedcm,
 * POST /auth/refresh and GET /auth/health. This file keeps OpenVibe.Inventory's own surface on top of it:
 *
 *   middleware()          req.viewer (the page renderer's shape), from sso.optionalAuth()
 *   routes()              the SDK's /auth router, plus this site's /auth/me body and the cross-site sign-out guard
 *   asViewer(req,res,fn)  run a Network call as the person, refreshing once on 401
 *   tokenGrant(fields)    a token request with this site's client
 *
 * The person's Network token still lives in httpOnly cookies. The old names (inventory_at, inventory_rt) are handed to
 * the SDK as legacyCookies, so nobody is signed out by the move: they are read as the session until the next sign-in or
 * refresh writes ov_token / ov_refresh and clears them.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { createSsoClient } = require('openvibe-sdk/sso');

const ACCESS_COOKIE = 'inventory_at';
const REFRESH_COOKIE = 'inventory_rt';
const HINT_COOKIE = 'ov_sso_hint';
const SDK_ACCESS_COOKIE = 'ov_token';
const SDK_REFRESH_COOKIE = 'ov_refresh';

/** Same-site relative paths only (never protocol-relative, never another origin). */
function sanitizeNext(next) {
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com" would
    // leave the site. A next with any control character or backslash goes home.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
    if (typeof next !== 'string' || !/^\/(?!\/|\\)/.test(next) || next.length > 500) return '/';
    return next;
}

function pkcePair() {
    const crypto = require('crypto');
    const verifier = crypto.randomBytes(32).toString('base64url');           // 43 characters
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function createSso({ config, keys, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const secure = config.cookies.secure;
    const sso = createSsoClient({
        site: 'inventory',
        siteName: 'OpenVibe.Inventory',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        redirectUri: config.oauth.redirectUri,
        issuer: config.networkIssuer,
        scope: config.oauth.scope,
        audience: config.oauth.sessionAudience,
        secureCookies: secure,
        httpOnlyAccess: true,
        legacyCookies: { access: [ACCESS_COOKIE], refresh: [REFRESH_COOKIE] },
        fetch: fetchImpl,
        log,
    });

    const cookieBase = (opts) => ({ sameSite: 'lax', secure, httpOnly: true, path: '/', ...opts });

    function setSession(res, data) {
        res.clearCookie(ACCESS_COOKIE, { path: '/' });
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        res.cookie(SDK_ACCESS_COOKIE, data.access_token, cookieBase({ maxAge: 24 * 60 * 60 * 1000 }));
        if (data.refresh_token) res.cookie(SDK_REFRESH_COOKIE, data.refresh_token, cookieBase({ path: '/auth', maxAge: 30 * 24 * 60 * 60 * 1000 }));
        res.cookie(HINT_COOKIE, 'account', { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
    }
    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, { path: '/' });
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        res.clearCookie(SDK_ACCESS_COOKIE, { path: '/' });
        res.clearCookie(SDK_REFRESH_COOKIE, { path: '/auth' });
    }
    function readRefresh(req) {
        const c = req.cookies || {};
        return c[SDK_REFRESH_COOKIE] || c[REFRESH_COOKIE] || null;
    }

    function viewerFromClaims(claims, token) {
        const subject = typeof claims.subject_id === 'string' ? claims.subject_id : null;
        const role = typeof claims.role === 'string' ? claims.role : 'user';
        return {
            kind: 'user',
            subject,
            username: typeof claims.username === 'string' ? claims.username.slice(0, 64) : null,
            displayName: typeof claims.display_name === 'string' ? claims.display_name.slice(0, 80) : (typeof claims.username === 'string' ? claims.username.slice(0, 64) : 'you'),
            role,
            // The person's Network access token: used for server-side Network calls, never rendered.
            token,
        };
    }

    /** One refresh per request, however many Network calls in it see a 401 (refresh tokens rotate). */
    async function refresh(req, res) {
        if (!req.sessionRefresh) req.sessionRefresh = await doRefresh(req, res);
        return req.sessionRefresh;
    }

    async function doRefresh(req, res) {
        const rt = readRefresh(req);
        if (!rt) return null;
        try {
            const data = await sso.tokenGrant({ grant_type: 'refresh_token', refresh_token: rt });
            setSession(res, data);
            const claims = await sso.verify(data.access_token);
            return claims ? viewerFromClaims(claims, data.access_token) : null;
        } catch (err) {
            if (err.status && err.status < 500) clearSession(res);
            return null;
        }
    }

    /** req.viewer for every page: the signed-in person (sso.optionalAuth puts req.user and req.token there). */
    function middleware() {
        const auth = sso.optionalAuth();
        return (req, res, next) => auth(req, res, () => {
            req.viewer = req.user ? viewerFromClaims(req.user, req.token) : { kind: 'anonymous' };
            next();
        });
    }

    /**
     * Run fn(token) as the viewer; when the Network answers 401 (expired or revoked session), refresh
     * once and run it again. Other failures are returned to the caller unchanged.
     */
    async function asViewer(req, res, fn) {
        try {
            return await fn(req.viewer && req.viewer.token);
        } catch (err) {
            if (!err || err.status !== 401) throw err;
            const fresh = await refresh(req, res);
            if (!fresh) throw err;
            req.viewer = fresh;
            return fn(fresh.token);
        }
    }

    // Sign-out ends the session, so another site must not be able to trigger it (a cross-site
    // <img src=/auth/logout> or link). A same-origin navigation or form, or the address bar
    // (Sec-Fetch-Site none), signs out directly; anything else gets a confirm button (POST).
    const sameOriginRequest = (req) => {
        const site = String(req.get('sec-fetch-site') || '');
        if (site) return site === 'same-origin' || (site === 'none' && req.method === 'GET');
        const origin = req.get('origin');
        if (origin) return origin === `${req.protocol}://${req.get('host')}`;
        return req.method === 'GET';    // no fetch metadata and no Origin: an old browser navigating
    };

    function routes() {
        const r = express.Router();

        // The shared navbar's silent sign-in sends the whole page address: keep its path before the SDK sees it.
        r.use((req, _res, next) => {
            if (req.method === 'GET' && req.path === '/login') {
                const target = sanitizeNext(req.query.next);
                if (target === '/') delete req.query.next; else req.query.next = target;
            }
            next();
        });

        // The navbar's { user } shape and the no-store header the shared pages expect.
        r.get('/me', async (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const claims = await sso.verify(sso.extractToken(req));
            if (!claims) return res.json({ user: null });
            const v = viewerFromClaims(claims, null);
            return res.json({ user: { username: v.username, display_name: v.displayName, subject_id: v.subject, role: v.role } });
        });

        r.get('/logout', (req, res, next) => {
            if (sameOriginRequest(req)) return next();
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const q = req.query.next ? `?next=${encodeURIComponent(sanitizeNext(req.query.next))}` : '';
            res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign out</title><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<form method="post" action="/auth/logout${q}" style="font:16px system-ui;margin:3em auto;max-width:24em;text-align:center">`
                + `<p>Sign out of OpenVibe.Inventory?</p><button type="submit">Sign out</button> <a href="/">Cancel</a></form>`);
        });
        r.post('/logout', (req, res, next) => (sameOriginRequest(req) ? next() : res.status(403).type('text/plain').send('Sign-out must come from this site.')));
        r.all('/logout', async (req, res) => {
            const rt = readRefresh(req);
            if (rt) {
                fetchImpl(`${config.networkInternalUrl}/oauth/revoke`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: rt }),
                    signal: AbortSignal.timeout(3000),
                }).catch(() => {});
            }
            clearSession(res);
            res.cookie(HINT_COOKIE, 'guest', { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
            res.redirect(303, sanitizeNext(req.query.next));
        });

        r.use(sso.router(express));
        return r;
    }

    return { middleware, routes, asViewer, tokenGrant: sso.tokenGrant, pkcePair, client: sso };
}

module.exports = { createSso, pkcePair, sanitizeNext, ACCESS_COOKIE, REFRESH_COOKIE };
