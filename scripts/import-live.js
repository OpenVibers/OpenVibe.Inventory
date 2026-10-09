#!/usr/bin/env node
'use strict';

/**
 * ADR-054 §8, convert and verify: Live's cosmetics become instances and equipped slots here
 * (server/inventory/import-live.js).
 *
 *   node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env           dry run
 *   node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env --apply   convert
 *   node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env --verify  compare
 *
 * Live's database is only read (SELECT). Its DATABASE_URL is taken from --live-env and never printed. The script prints
 * counts and subjects only. --verify exits 1 when anyone differs.
 */
const fs = require('fs');
const { createDb } = require('openvibe-sdk/db');
const { createServiceOutbox } = require('openvibe-sdk/events');
const configLib = require('../server/config');
const { openDb, createStore } = require('../server/db');
const { createInventory } = require('../server/inventory/store');
const { seed } = require('../server/inventory/seed');
const { importLive, verifyLive } = require('../server/inventory/import-live');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

function readEnvValue(file, key) {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
    if (!line) throw new Error(`${key} is not in ${file}`);
    return line.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

(async () => {
    const liveEnv = opt('live-env');
    if (!liveEnv) throw new Error('--live-env <Live\'s env file> is required (its DATABASE_URL is read, never printed)');
    const quiet = { log() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
    const live = createDb({ url: readEnvValue(liveEnv, 'DATABASE_URL'), service: 'inventory-import-live', max: 1, log: quiet });
    const db = await openDb(configLib.load(), { log: quiet });
    const s = createStore(db);
    const inv = createInventory({ s, outbox: createServiceOutbox({ db, source: 'inventory', log: quiet }), log: quiet });
    await seed(inv, { log: quiet });
    try {
        if (flag('verify')) {
            const v = await verifyLive({ live, inv, db });
            for (const d of v.differences) console.log(`  ${d.subject}: missing ${d.missing.join(',') || '-'}; slots differing ${d.slots.join(',') || '-'}`);
            if (v.unknown.length) console.log(`  not in Live's catalog any more (not imported): ${v.unknown.join(', ')}`);
            console.log(v.differences.length ? `verify: ${v.differences.length} of ${v.people} people differ` : `verify: all ${v.people} people match (${v.unlocks} unlocks, ${v.equippedSlots} slots)`);
            process.exitCode = v.differences.length ? 1 : 0;
            return;
        }
        const r = await importLive({ live, inv, db, apply: flag('apply'), log: console });
        console.log(JSON.stringify({ apply: flag('apply'), ...r }));
    } finally {
        await live.close();
        await db.close();
    }
})().catch((err) => { console.error(`import-live failed: ${err.message}`); process.exit(1); });
