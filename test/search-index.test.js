'use strict';
/**
 * Item pages in OpenVibe.Search (server/search-index.js): a sweep puts every published item in the outbox as one
 * inventory.index_document.upserted, exactly the contract, with its /items/<id> page (which answers); a second sweep
 * sends nothing; a retired item stays, marked noindex, like its page; a draft is a tombstone, like its 404; the
 * definition writes name what they changed.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const { s, searchIndex } = t.ctx;
    const docs = async () => (await s.db.many("SELECT envelope FROM event_outbox WHERE envelope->>'event_type' LIKE 'inventory.index_document.%' ORDER BY id")).map((r) => r.envelope);
    const valid = (env) => {
        assert.ok(contracts.validate('events.event-envelope@1', env).valid, 'envelope');
        const p = contracts.validate(env.event_type, env.payload);
        assert.ok(p.valid, `${env.event_type}: ${JSON.stringify(p.errors)}`);
        assert.strictEqual(env.source, 'inventory');
        return env;
    };
    let id;

    try {
        await check('a sweep sends every published item once, as the contract says, and its page answers', async () => {
            const published = await s.db.many("SELECT * FROM inventory_definitions WHERE status = 'published' ORDER BY id");
            assert.ok(published.length > 3, 'the seed published items');
            const res = await searchIndex.sweep();
            assert.strictEqual(res.definition.failed, 0);
            const envs = (await docs()).map(valid);
            assert.strictEqual(envs.length, published.length);
            id = published[0].id;
            const doc = envs.find((e) => e.payload.id === id).payload;
            assert.strictEqual(doc.canonical_url, `${t.config.baseUrl}/items/${id}`);
            assert.ok(doc.title.startsWith(`${published[0].name} · `));
            assert.strictEqual(doc.facets.rarity, published[0].rarity);
            assert.deepStrictEqual(doc.indexability, { decision: 'index', reasons: [] });
            assert.strictEqual((await t.get(`/items/${id}`)).status, 200);
            assert.strictEqual((await searchIndex.sweep()).definition.sent, 0, 'a second sweep sends nothing');
        });

        await check('a retired item stays in Search marked noindex; a draft is a tombstone', async () => {
            await s.db.exec("UPDATE inventory_definitions SET status = 'retired' WHERE id = $1", [id]);
            await searchIndex.syncId(id);
            let env = valid((await docs()).pop());
            assert.strictEqual(env.event_type, 'inventory.index_document.upserted');
            assert.strictEqual(env.payload.indexability.decision, 'noindex');
            await s.db.exec("UPDATE inventory_definitions SET status = 'draft' WHERE id = $1", [id]);
            await searchIndex.syncId(id);
            env = valid((await docs()).pop());
            assert.strictEqual(env.event_type, 'inventory.index_document.deleted');
            assert.strictEqual((await t.get(`/items/${id}`)).status, 404);
            await s.db.exec("UPDATE inventory_definitions SET status = 'published' WHERE id = $1", [id]);
        });

        await check('the definition writes name what they changed, and the change is synced', async () => {
            // watch() wraps createDefinition, updateDefinition, updateWorkshopItem, review and takedown; a write answers
            // the definition ({ id }) or { definition }, and that id is synced a moment later.
            await s.db.exec("UPDATE inventory_definitions SET description = 'Burns brighter.' WHERE id = $1", [id]);
            const before = (await docs()).length;
            const wrapped = searchIndex.watch({ review: async () => ({ id }), takedown: async () => ({ definition: { id }, revoked: 0 }), grant: async () => ({ id: 'not-a-definition-write' }) });
            await wrapped.review();
            await searchIndex.settle();
            const after = await docs();
            assert.strictEqual(after.length, before + 1, 'the touched item was synced once');
            assert.match(valid(after[after.length - 1]).payload.summary, /Burns brighter/);
            await wrapped.takedown();
            await wrapped.grant();
            await searchIndex.settle();
            assert.strictEqual((await docs()).length, before + 1, 'unchanged since: nothing more; grant is not wrapped');
        });
    } finally {
        await done(t);
    }
})();
