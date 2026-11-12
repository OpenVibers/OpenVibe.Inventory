'use strict';
// Size budgets for inventory.openvibe.network's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0.
// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 356.6 KB raw / 85.0 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 353.9 KB raw / 84.4 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 352.9 KB raw / 84.2 KB brotli.
const BUDGETS = {
    htmlRawKB: 46.5, // 46.5 openvibe-shared v4.202.0 (2026-11-11: measured 46.1, raised by pin-bump from 45.5); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 43.8: measured 41.8 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    htmlBrotliKB: 10.5,   // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 8.2 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 6.2
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 394.5, // 2026-11-10: openvibe-shared 4.197.0 (the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 2,   // 2 (app.css + the cached /shared/showcase.css)
    cssRawKB: 60, // 60 openvibe-shared v4.229.0 (2026-11-12: measured 59.8, raised by pin-bump from 52.8); 52.8: measured 47.8 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 11, // 11 openvibe-shared v4.229.0 (2026-11-12: measured 10.8, raised by pin-bump from 10.5); 10.5 openvibe-shared v4.225.0 (2026-11-12: measured 10.1, raised by pin-bump from 10); 9.7 with the tiles, the slots and the counted folds (2026-11-08, the owner: better on a phone); 8.5 with 2026-11-01: phone table cards (2026-11-01); 8.2 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 6.4 with Shared 4.13.0 (2026-10-26: account links); 4.9
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', INVENTORY_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (INVENTORY_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
