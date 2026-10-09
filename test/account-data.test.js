'use strict';
/**
 * ADR-033 / ADR-054 §7: Inventory's part of an account export and of an account deletion, through the signed loopback
 * route POST /internal/events with a stand-in Network. Alice's items, equipped set and history are exported; her
 * deletion removes her items and equipped set, keeps the ledger rows without her, keeps the supply count true, leaves
 * Bob's items alone and confirms once.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_inventory', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ env: { INVENTORY_EVENTS_SECRET: SECRET }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'inventory', clientSecret: 'inventory-secret' }) });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const db = t.ctx.s.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    const inv = t.ctx.inv;
    let crown;

    try {
        await check('alice and bob own items; alice wears one', async () => {
            crown = await inv.byAlias('service:live', 'hat_crown');
            const rainbow = await inv.byAlias('service:live', 'fx_rainbow');
            for (const [who, key] of [[alice, 'a1'], [bob, 'b1']]) await inv.grant('service:live', { definition_id: crown.id, subject: who.subject, idempotency_key: `test-0000-${key}` });
            const r = await inv.grant('service:live', { definition_id: rainbow.id, subject: alice.subject, idempotency_key: 'test-0000-a2' });
            await inv.equip(alice.subject, `user:${alice.subject}`, { kind: 'live.name_effect', slot: 'name_effect', instance_id: r.instance.id });
        });

        await check('the export carries her items, equipped set and history, and nothing of bob\'s', async () => {
            const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: alice.subject }));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_inventory');
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['equipped.json', 'history.json', 'items.json']);
            assert.strictEqual(part.body.files.find((f) => f.name === 'items.json').content.length, 2);
            assert.ok(!JSON.stringify(part.body).includes(bob.subject));
        });

        await check('the deletion removes her items and equipped set, keeps the ledger without her, and confirms once', async () => {
            const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: alice.subject });
            const r = await deliver(event);
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
            assert.strictEqual(await count('SELECT count(*) FROM inventory_instances WHERE owner_subject = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM inventory_equipped WHERE owner_subject = $1', [alice.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM inventory_ledger WHERE owner_subject = $1 OR actor = $2', [alice.subject, `user:${alice.subject}`]), 0);
            assert.ok(await count('SELECT count(*) FROM inventory_ledger WHERE owner_subject IS NULL') >= 3, 'her history stays, without her');
            assert.strictEqual(await count('SELECT count(*) FROM inventory_instances WHERE owner_subject = $1', [bob.subject]), 1, 'bob keeps his');
            assert.strictEqual(await count('SELECT supply_issued FROM inventory_definitions WHERE id = $1', [crown.id]), 2, 'the supply count stays true');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.deepStrictEqual([conf[0].body.erased.inventory_instances, conf[0].body.erased.inventory_equipped], [2, 1]);
            assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
        });

        await check('the route refuses a bad signature and a request that came through a proxy', async () => {
            const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: alice.subject });
            assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
            assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
