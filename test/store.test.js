'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createCommerce } = require('../server/inventory/commerce');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice'), bob = t.network.addUser('bob'), staff = t.network.addUser('staff', { role: 'admin' });
    const token = t.network.userToken(alice);
    const payments = new Map(); let lose = false, frozen = false;
    t.ctx.commerce = createCommerce(t.ctx, { fetchImpl: async (url, options) => {
        assert.strictEqual(url, t.config.billingUrl + '/api/v1/me/store/spend');
        assert.strictEqual(options.headers.Authorization, `Bearer ${token}`);
        const { purchase_id } = JSON.parse(options.body);
        const p = await t.ctx.commerce.purchase(alice.subject, purchase_id);
        if (frozen) return { ok: false, status: 503, json: async () => ({ code: 'billing.frozen' }) };
        payments.set(p.id, { purchase_id: p.id, payment_id: `txn:${p.id}`, currency: p.currency, amount: p.amount });
        if (lose) { lose = false; throw new Error('lost response'); }
        return { ok: true, json: async () => payments.get(p.id) };
    } });
    const api = (path, options = {}) => t.get('/api/v1' + path, options);
    const rainbow = await t.ctx.inv.byAlias('service:live', 'fx_rainbow');
    const crown = await t.ctx.inv.byAlias('service:live', 'hat_crown');
    try {
        await check('unreviewed offers stay hidden; only the issuer submits and verified staff approve', async () => {
            await assert.rejects(t.ctx.commerce.submit('service:quest', rainbow.id, { prices: { vibes: 12 } }), (e) => e.status === 403);
            const noCap = await api(`/store/${rainbow.id}/list`, { bearer: t.network.serviceToken('live', []), json: { prices: { vibes: 12 } } });
            assert.strictEqual(noCap.status, 403);
            const submitted = await api(`/store/${rainbow.id}/list`, { bearer: t.network.serviceToken('live', ['inventory.store.list']), json: { prices: { vibes: 12, coins: 20 } } });
            assert.strictEqual(submitted.status, 201, submitted.text);
            assert.deepStrictEqual((await api('/store')).json().items, []);
            assert.strictEqual((await api(`/store/${rainbow.id}/review`, { bearer: token, json: { approve: true } })).status, 403);
            const r = await api(`/store/${rainbow.id}/review`, { bearer: t.network.userToken(staff), json: { approve: true } });
            assert.strictEqual(r.status, 200, r.text);
            const item = (await api('/store')).json().items[0];
            assert.strictEqual(item.issuer, 'service:live'); assert(item.preview && item.surfaces.length);
            assert.deepStrictEqual(item.prices, { vibes: 12, coins: 20 });
        });
        await check('bearer purchase ignores a supplied price and subject; retry and alternate keys deliver once', async () => {
            const body = { currency: 'vibes', idempotency_key: 'rainbow-purchase', amount: 1, subject: bob.subject };
            const a = await api(`/store/${rainbow.id}/buy`, { bearer: token, json: body });
            assert.strictEqual(a.status, 200, a.text); assert.strictEqual(a.json().amount, 12);
            assert.strictEqual(a.json().subject, alice.subject);
            const b = await api(`/store/${rainbow.id}/buy`, { bearer: token, json: { ...body, idempotency_key: 'another-key-same-item' } });
            assert.strictEqual(b.json().instance_id, a.json().instance_id); assert.strictEqual(payments.size, 1);
            assert.strictEqual((await api('/store', { bearer: token })).json().items[0].owned, true);
            assert.strictEqual((await api(`/store/purchases/${a.json().id}`, { bearer: t.network.userToken(bob) })).status, 404);
            assert.strictEqual((await api(`/store/${rainbow.id}/buy`, { as: alice, json: body })).status, 401);
        });
        await check('lost payment response and concurrent retries deliver one item', async () => {
            await t.ctx.commerce.submit('service:live', crown.id, { prices: { coins: 30 } });
            await t.ctx.commerce.review('user:staff', crown.id, true);
            const body = { currency: 'coins', idempotency_key: 'crown-purchase-01' };
            lose = true;
            assert.strictEqual((await api(`/store/${crown.id}/buy`, { bearer: token, json: body })).status, 504);
            const [a, b] = await Promise.all([api(`/store/${crown.id}/buy`, { bearer: token, json: body }), api(`/store/${crown.id}/buy`, { bearer: token, json: body })]);
            assert.strictEqual(a.status, 200, a.text); assert.strictEqual(b.status, 200, b.text);
            assert.strictEqual(a.json().instance_id, b.json().instance_id); assert.strictEqual(payments.size, 2);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT count(*) FROM inventory_ledger WHERE action = 'purchased'")), 2);
            const eq = await api('/me/equipped', { bearer: token, method: 'PUT', json: { kind: crown.kind, slot: 'hat', instance_id: a.json().instance_id } });
            assert.strictEqual(eq.status, 200, eq.text);
        });
        await check('price changes require another review and bearer CORS does not allow cookies or tenant origins', async () => {
            await t.ctx.commerce.submit('service:live', rainbow.id, { prices: { vibes: 99 } });
            assert(!(await api('/store')).json().items.some((i) => i.id === rainbow.id));
            const pre = await api('/me/equipped', { method: 'OPTIONS', headers: { Origin: 'https://openvibe.live' } });
            assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://openvibe.live');
            assert.strictEqual(pre.headers.get('access-control-allow-credentials'), null);
            const bad = await api('/store', { headers: { Origin: 'https://x.openvibe.website' } });
            assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);
        });
    } finally { await t.close(); }
    done();
})();
