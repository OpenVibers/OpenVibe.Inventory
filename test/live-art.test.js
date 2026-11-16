'use strict';
/**
 * Live's items drawn (2026-11-16; the owner: item icons as emoji look cheap, so each of Live's items gets art drawn in
 * the house item style on openvibe.design, stored in OpenVibe.Media). server/data/live-art.json names a Media object
 * per alias; the boot seed sets it as the definition's art.media_id, keeps its emoji and CSS token beside it, and a
 * second boot changes nothing. The pages show the drawing, not the emoji.
 */
const assert = require('assert');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const { art } = require(path.join(__dirname, '..', 'server', 'data', 'live-art.json'));
const { definitions } = require(path.join(__dirname, '..', 'server', 'data', 'live-definitions.json'));

(async () => {
    const t = await boot();
    const inv = t.ctx.inv;
    try {
        await check('the file names a Media object for Live\'s items, and only for items Live has', async () => {
            const aliases = new Set(definitions.map((d) => d.alias));
            const named = Object.keys(art);
            assert.ok(named.length >= Math.floor(definitions.length * 0.9), `most of Live's ${definitions.length} items are drawn (${named.length})`);
            for (const a of named) {
                assert.ok(aliases.has(a), `${a} is one of Live's items`);
                assert.match(art[a].media_id, /^med_[0-9A-HJKMNP-TV-Z]{26}$/, `${a}: a Media object`);
            }
            assert.strictEqual(new Set(named.map((a) => art[a].media_id)).size, named.length, 'each item its own drawing');
        });

        await check('the boot seed sets each drawing as the item\'s art, beside its emoji and token', async () => {
            for (const [alias, a] of Object.entries(art)) {
                const d = await inv.byAlias('service:live', alias);
                const seeded = definitions.find((x) => x.alias === alias).art;
                assert.strictEqual(d.art.media_id, a.media_id, `${alias}: drawn`);
                assert.strictEqual(d.art.emoji, seeded.emoji, `${alias}: its emoji stays, for what cannot show a picture`);
                if (seeded.token) assert.strictEqual(d.art.token, seeded.token, `${alias}: its CSS token stays`);
            }
            const again = await require('../server/inventory/seed').seed(inv, { log: { log() {} } });
            assert.strictEqual(again.art, 0, 'a second boot changes nothing');
        });

        await check('an item\'s page shows its drawing', async () => {
            const [alias, a] = Object.entries(art)[0];
            const d = await inv.byAlias('service:live', alias);
            const page = await t.get(`/items/${d.id}`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes(`https://openvibe.media/o/${a.media_id}`), 'the drawing, from Media');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
