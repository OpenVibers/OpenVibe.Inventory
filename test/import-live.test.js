'use strict';
/**
 * ADR-054 §8: Live's cosmetics move here row for row. A stand-in Live database (Live's own three columns) holds two
 * people's unlocks and equipped slots (their subjects in linked_accounts, as Live keeps them), an account without a
 * Network subject and an item Live no longer sells. The dry
 * run changes nothing; the import grants with origin `migrated` and the unlock time, equips the slots, and a second run
 * grants nothing again; verify then reports no difference.
 */
const assert = require('assert');
const { createDb } = require('openvibe-sdk/db');
const { boot, check, done } = require('./helpers/boot');
const { importLive, verifyLive, isoOf } = require('../server/inventory/import-live');

(async () => {
    const t = await boot();
    const live = createDb({ pglite: true });
    const db = t.ctx.s.db;
    const inv = t.ctx.inv;
    const A = 'usr_01JZ0000000000000000000AAA';
    const B = 'usr_01JZ0000000000000000000BBB';
    const quiet = { log() {}, warn() {} };

    try {
        await live.exec(`CREATE TABLE linked_accounts (user_id bigint, service text, service_user_id text, subject_id text);
            CREATE TABLE user_cosmetics (id bigint GENERATED ALWAYS AS IDENTITY, user_id bigint, item_id text, category text, unlocked_at text);
            CREATE TABLE user_equipped (user_id bigint, slot text, item_id text);
            INSERT INTO linked_accounts VALUES (1, 'network', '901', '${A}'), (2, 'network', '902', '${B}'), (3, 'network', '903', NULL), (2, 'tools', '77', 'x');
            INSERT INTO user_cosmetics (user_id, item_id, category, unlocked_at) VALUES
                (1, 'fx_rainbow', 'name_effect', '2026-09-01 12:00:00'), (1, 'hat_crown', 'hat', '2026-09-02 08:30:00'), (1, 'gary', 'voice', '2026-09-03 00:00:00'),
                (2, 'fx_fire', 'name_effect', '2026-09-04 10:00:00'), (2, 'fx_retired_thing', 'name_effect', '2026-09-05 10:00:00'),
                (3, 'fx_ice', 'name_effect', '2026-09-06 10:00:00');
            INSERT INTO user_equipped VALUES (1, 'name_effect', 'fx_rainbow'), (1, 'hat', 'hat_crown'), (2, 'name_effect', 'fx_fire'), (2, 'particle', 'px_hearts');`);

        await check('the dry run counts and changes nothing', async () => {
            const r = await importLive({ live, inv, db, apply: false, log: quiet });
            assert.deepStrictEqual([r.people, r.unlocks, r.noSubject, r.granted, r.equipped], [2, 6, 1, 4, 4]);
            assert.deepStrictEqual(r.unknown.sort(), ['fx_retired_thing'], 'an item Live no longer sells is named, not guessed');
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM inventory_instances')), 0);
        });

        await check('the import grants with origin migrated and the unlock time, and equips the slots', async () => {
            const r = await importLive({ live, inv, db, apply: true, log: quiet });
            assert.deepStrictEqual([r.granted, r.alreadyHere, r.equipped, r.notOwned], [4, 0, 3, 1], 'bob wears hearts he never unlocked: left empty');
            const mine = (await inv.inventory(A, { own: true })).instances;
            assert.strictEqual(mine.length, 3);
            assert.ok(mine.every((i) => i.origin === 'migrated'));
            const crown = await inv.byAlias('service:live', 'hat_crown');
            assert.strictEqual(mine.find((i) => i.definition_id === crown.id).acquired_at, isoOf('2026-09-02 08:30:00'));
            const eq = (await inv.equipped([A]))[0].slots;
            assert.deepStrictEqual(Object.keys(eq).sort(), ['live.hat:hat', 'live.name_effect:name_effect']);
        });

        await check('a second run grants nothing again, and verify finds no difference', async () => {
            const again = await importLive({ live, inv, db, apply: true, log: quiet });
            assert.deepStrictEqual([again.granted, again.alreadyHere], [0, 4]);
            assert.strictEqual(Number(await db.value('SELECT count(*) FROM inventory_instances')), 4);
            const v = await verifyLive({ live, inv, db });
            assert.deepStrictEqual(v.differences, []);
        });

        await check('verify names a person who differs', async () => {
            await live.exec("INSERT INTO user_cosmetics (user_id, item_id, category, unlocked_at) VALUES (1, 'px_sparkle', 'particle', '2026-09-07 00:00:00')");
            const v = await verifyLive({ live, inv, db });
            assert.deepStrictEqual(v.differences, [{ subject: A, missing: ['px_sparkle'], slots: [] }]);
        });
    } finally {
        await live.close();
        await t.close();
    }
    done();
})();
