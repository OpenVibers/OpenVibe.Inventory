'use strict';
/**
 * Public reads from any site (openvibe-shared/items.js): the catalog and anyone's items and equipped set answer every
 * origin with Access-Control-Allow-Origin: * and a cross-origin resource policy, preflight included. The person's own
 * routes, writes and the pages keep same-site and send no CORS header.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const A = 'usr_01JZ0000000000000000000AAA';
    const origin = { origin: 'https://openvibe.community' };
    try {
        await check('the public reads answer every origin', async () => {
            for (const p of ['/api/v1/kinds', '/api/v1/kinds/live.hat', '/api/v1/definitions?kind=live.hat', `/api/v1/equipped?subjects=${A}`, `/api/v1/people/${A}/items`, `/api/v1/people/${A}/equipped`]) {
                const r = await t.get(p, { headers: origin });
                assert.strictEqual(r.status, 200, p);
                assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', p);
                assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'cross-origin', p);
                assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, `${p}: never with credentials`);
            }
            const one = (await t.get('/api/v1/definitions?kind=live.hat')).json().definitions[0];
            const r = await t.get(`/api/v1/definitions/${one.id}`, { headers: origin });
            assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        });
        await check('a preflight is answered for them', async () => {
            const r = await t.get('/api/v1/equipped', { method: 'OPTIONS', headers: { ...origin, 'access-control-request-method': 'GET' } });
            assert.strictEqual(r.status, 204);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
            assert.match(r.headers.get('access-control-allow-methods') || '', /GET/);
        });
        await check('everything else stays same-site', async () => {
            for (const [p, method] of [['/api/v1/me/items', 'GET'], ['/api/v1/grants', 'POST'], ['/api/v1/me/equipped', 'PUT'], ['/api/v1/ping', 'GET'], ['/items', 'GET']]) {
                const r = await t.get(p, { method, headers: origin });
                assert.strictEqual(r.headers.get('access-control-allow-origin'), null, `${method} ${p}`);
                assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'same-site', `${method} ${p}`);
            }
        });
    } finally {
        await t.close();
    }
    done();
})();
