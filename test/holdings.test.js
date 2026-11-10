'use strict';
const assert = require('assert');
const { performance } = require('perf_hooks');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const person = t.network.addUser('holdings-reader');
    const db = t.ctx.s.db;
    const api = (path) => t.get(`/api/v1${path}`, { as: person });
    try {
        // One statement per table keeps fixture setup separate from the measured read.
        await db.exec(`INSERT INTO inventory_definitions
            (id, kind, name, art, rarity, attributes, issuer, supply_issued, status, created_at, updated_at)
            SELECT 'itd_' || lpad(n::text, 26, '0'), 'live.hat', 'Hat ' || lpad(n::text, 5, '0'), '{"emoji":"◆"}'::jsonb,
                CASE WHEN n % 2 = 0 THEN 'rare' ELSE 'common' END, '{}'::jsonb,
                CASE WHEN n % 3 = 0 THEN 'service:quest' ELSE 'service:live' END, 1, 'published',
                '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z' FROM generate_series(1, 5000) n`);
        await db.exec(`INSERT INTO inventory_instances
            (id, definition_id, owner_subject, origin, state, attributes, acquired_at, updated_at)
            SELECT 'inv_' || lpad(n::text, 26, '0'), 'itd_' || lpad(n::text, 26, '0'), $1,
                'earned', 'owned', '{}'::jsonb, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'
            FROM generate_series(1, 5000) n`, [person.subject]);
        await db.exec(`INSERT INTO inventory_instances
            (id, definition_id, owner_subject, origin, state, attributes, acquired_at, updated_at)
            VALUES ('inv_' || lpad('5001', 26, '0'), 'itd_' || lpad('5000', 26, '0'), $1,
                'earned', 'owned', '{}'::jsonb, '2026-11-10T00:00:01Z', '2026-11-10T00:00:01Z')`, [person.subject]);
        await db.exec('ANALYZE inventory_instances');
        await db.exec(`INSERT INTO inventory_equipped (owner_subject, kind, slot, instance_id, updated_at)
            VALUES ($1, 'live.hat', 'hat', 'inv_' || lpad('5000', 26, '0'), '2026-11-10T00:00:02Z')`, [person.subject]);
        await check('stack count, count route, filters and sorts are SQL-backed', async () => {
            const first = (await api('/me/holdings?limit=2')).json();
            assert.strictEqual(first.holdings[0].count, 2);
            assert.strictEqual(first.holdings[0].equipped, true, 'another instance in the stack is equipped');
            assert.strictEqual((await api('/me/holdings/count')).json().count, 5000);
            assert.strictEqual((await api('/me/holdings/count?rarity=rare')).json().count, 2500);
            assert.strictEqual((await api('/me/holdings/count?issuer=service%3Aquest')).json().count, 1666);
            assert.strictEqual((await api('/me/holdings/count?site=quest')).json().count, 1666);
            assert.strictEqual((await api('/me/holdings/count?kind=live.hat')).json().count, 5000);
            assert.strictEqual((await api('/me/holdings/count?equipped=true')).json().count, 1);
            assert.strictEqual((await api('/me/holdings/count?equipped=false')).json().count, 4999);
            assert.strictEqual((await api('/me/holdings/count?text=05000')).json().count, 1);
            assert.strictEqual((await api('/me/holdings/count?tradable=true')).json().count, 0);
            assert.strictEqual((await api('/me/holdings?sort=count&limit=1')).json().holdings[0].count, 2);
            assert.strictEqual((await api('/me/holdings?sort=name&limit=1')).json().holdings[0].definition.name, 'Hat 00001');
            assert.strictEqual((await api('/me/holdings?sort=rarity&limit=1')).json().holdings[0].definition.rarity, 'rare');
            assert.strictEqual((await api('/me/holdings?limit=201')).status, 400);
        });
        await check('cursor holds a stable boundary while new items arrive', async () => {
            const a = (await api('/me/holdings?limit=2')).json();
            const byCount = (await api('/me/holdings?sort=count&limit=1')).json();
            await db.exec(`INSERT INTO inventory_instances
                (id, definition_id, owner_subject, origin, state, attributes, acquired_at, updated_at)
                VALUES ('inv_' || lpad('5002', 26, '0'), 'itd_' || lpad('4999', 26, '0'), $1,
                'earned', 'owned', '{}'::jsonb, '2026-11-10T00:00:02Z', '2026-11-10T00:00:02Z')`, [person.subject]);
            const response = await api(`/me/holdings?limit=2&cursor=${encodeURIComponent(a.next_cursor)}`);
            assert.strictEqual(response.status, 200, `${response.text} ${t.logs().slice(-1000)}`);
            const b = response.json();
            assert.strictEqual(b.holdings.length, 2);
            assert(!b.holdings.some((h) => a.holdings.some((prior) => prior.definition.id === h.definition.id)));
            assert.strictEqual((await api(`/me/holdings?limit=2&sort=name&cursor=${encodeURIComponent(a.next_cursor)}`)).status, 400);
            const nextCount = (await api(`/me/holdings?sort=count&limit=1&cursor=${encodeURIComponent(byCount.next_cursor)}`)).json();
            assert.strictEqual(nextCount.holdings[0].count, 1, 'new grant does not change the count sort snapshot');
        });
        await check('public query cannot request private holdings', async () => {
            await db.exec("UPDATE inventory_definitions SET status = 'draft' WHERE id = 'itd_' || lpad('4998', 26, '0')");
            const path = `/people/${person.subject}/holdings`;
            assert.strictEqual((await api(`${path}/count?own=true`)).json().count, 4999);
            assert.strictEqual((await api(`${path}?own=true&text=04998`)).json().holdings.length, 0);
            assert.strictEqual((await api('/me/holdings/count')).json().count, 5000);
        });
        await check('pages render a first batch and a next-page link', async () => {
            const mine = await t.get('/me', { as: person });
            assert.strictEqual(mine.status, 200, mine.text.slice(-300));
            assert.match(mine.text, /id="inventory-next"/);
            assert.match(mine.text, /data-endpoint="\/api\/v1\/me\/holdings"/);
            assert.match(mine.text, /Next items/);
            const publicPage = await t.get(`/u/${person.subject}`);
            assert.strictEqual(publicPage.status, 200);
            assert.match(publicPage.text, /data-endpoint="\/api\/v1\/people\/.+\/holdings"/);
        });
        await check('5,000 holdings return a warmed page in under 50 ms on PGlite', async () => {
            await t.ctx.inv.holdings.page(person.subject, { own: true });
            const start = performance.now();
            const page = await t.ctx.inv.holdings.page(person.subject, { own: true });
            const ms = performance.now() - start;
            assert.strictEqual(page.holdings.length, 60);
            assert(ms < 50, `page took ${ms.toFixed(1)} ms`);
            process.stdout.write(`holdings page: ${ms.toFixed(1)} ms\n`);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
