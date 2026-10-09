'use strict';
/**
 * The Workshop (ADR-054 §6 amendment, Contracts 0.124.0). A person submits a badge through the no-JavaScript form (the
 * image checked by its own bytes, stored through a stand-in Media); it is in review, credited to them and shown to
 * nobody else; staff reject it with a reason the creator reads, or publish it with a rarity; the creator gives it by
 * @name (granted, idempotent per person, within the cap); the person wears it and the equipped read carries its image.
 * Non-staff never review; the limits hold; the kind is a Workshop kind in the public API.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { inspect } = require('../server/workshop/image');

/** A PNG header for a w×h image (inspect reads only the signature and IHDR). */
function png(w, h, pad = 200) {
    const b = Buffer.alloc(33 + pad);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
}
/** A lossless WebP header for a w×h image. */
function webp(w, h) {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1');
    b.writeUInt32LE(20, 16); b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
    return b;
}
function multipart(fields, file) {
    const boundary = '----ovtest' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

(async () => {
    const uploads = [];
    let n = 0;
    const workshopMedia = { enabled: () => true, async upload(o) { uploads.push(o); n++; return `med_01JZ00000000000000000000${String(n).padStart(2, '0')}`; } };
    const names = new Map();
    const people = { async subjectOf(name) { return names.get(String(name).replace(/^@/, '').toLowerCase()) || null; } };
    const t = await boot({ workshopMedia, people });
    const alice = t.network.addUser('alice');
    const carol = t.network.addUser('carol');
    const staff = t.network.addUser('boss', { role: 'admin' });
    names.set('carol', carol.subject);
    const origin = { origin: t.base };
    const submit = async (who, fields, file) => {
        const m = multipart(fields, file);
        return t.get('/workshop/new', { as: who, method: 'POST', body: m.body, headers: { 'content-type': m.type, ...origin } });
    };
    const form = (who, path, fields) => t.get(path, { as: who, method: 'POST', form: fields, headers: origin });
    const inv = t.ctx.inv;
    try {
        await check('images are judged by their own bytes: square PNG or WebP, 64 to 512 pixels, at most 200 KB', async () => {
            assert.deepStrictEqual(inspect(png(128, 128)), { type: 'image/png', width: 128, height: 128 });
            assert.deepStrictEqual(inspect(webp(64, 64)), { type: 'image/webp', width: 64, height: 64 });
            assert.match(inspect(png(128, 96)).error, /square/);
            assert.match(inspect(png(32, 32)).error, /64 to 512/);
            assert.match(inspect(png(128, 128, 210 * 1024)).error, /at most 200 KB/);
            assert.match(inspect(Buffer.from('GIF89a........................')).error, /PNG or WebP/);
        });

        await check('network.badge is a Workshop kind in the public API', async () => {
            const kinds = (await t.get('/api/v1/kinds')).json().kinds;
            const badge = kinds.find((k) => k.id === 'network.badge');
            assert.deepStrictEqual([badge.workshop, badge.slots, badge.surfaces.map((s) => s.renderer)], [true, ['badge'], ['network.badge.image@1', 'network.badge.image@1']]);
        });

        let first;
        await check('a person submits a badge: in review, credited to them, shown to nobody else', async () => {
            const r = await submit(alice, { name: 'OG Viewer', description: 'First stream crew', supply_cap: '50', rights: 'yes' }, png(128, 128));
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.headers.get('location'), /^\/workshop\/mine\?done=/);
            assert.strictEqual(uploads[0].ownerSubject, alice.subject);
            first = (await inv.workshopItems({ issuer: `user:${alice.subject}` }))[0];
            assert.deepStrictEqual([first.status, first.rarity, first.issuer, first.credit, first.supply.cap, first.art], ['in_review', 'common', `user:${alice.subject}`, { subject: alice.subject, name: 'alice' }, 50, { media_id: 'med_01JZ0000000000000000000001' }]);
            assert.ok(!(await t.get('/workshop')).text.includes('OG Viewer'), 'not on the public Workshop');
            assert.strictEqual((await t.get(`/items/${first.id}`)).status, 404, 'no public item page');
            assert.ok((await t.get('/workshop/mine', { as: alice })).text.includes('In review'));
        });

        await check('a bad submission is refused with its reason, and nothing is stored', async () => {
            const before = uploads.length;
            let r = await submit(alice, { name: 'Wide', supply_cap: '5', rights: 'yes' }, png(200, 100));
            assert.match(decodeURIComponent(r.headers.get('location')), /square/);
            r = await submit(alice, { name: 'No rights', supply_cap: '5' }, png(128, 128));
            assert.match(decodeURIComponent(r.headers.get('location')), /made the image/);
            const foreign = multipart({ name: 'x', supply_cap: '5', rights: 'yes' }, png(128, 128));
            r = await t.get('/workshop/new', { as: alice, method: 'POST', body: foreign.body, headers: { 'content-type': foreign.type, origin: 'https://evil.example' } });
            assert.strictEqual(r.status, 403, 'a form from another site');
            assert.strictEqual(uploads.length, before);
        });

        await check('only staff see the queue and decide; a rejection reaches its creator', async () => {
            assert.strictEqual((await t.get('/workshop/review', { as: alice })).status, 403);
            assert.strictEqual((await form(alice, `/workshop/${first.id}/review`, { decision: 'publish' })).status, 403);
            const q = await t.get('/workshop/review', { as: staff });
            assert.ok(q.text.includes('OG Viewer') && q.text.includes('@alice'));
            const r = await form(staff, `/workshop/${first.id}/review`, { decision: 'reject', reason: 'Too close to a channel logo.' });
            assert.strictEqual(r.status, 303);
            const after = await inv.getDefinition(first.id);
            assert.strictEqual(after.status, 'draft');
            assert.match((await t.get('/workshop/mine', { as: alice })).text, /Staff(&#39;|&#x27;|')s reason: Too close to a channel logo\./);
        });

        let badge;
        await check('a published badge is public, given by @name within its cap, and worn with its image', async () => {
            await submit(alice, { name: 'Night Owl', supply_cap: '2', rights: 'yes' }, webp(256, 256));
            badge = (await inv.workshopItems({ status: 'in_review' })).find((d) => d.name === 'Night Owl');
            const api = await t.get(`/api/v1/definitions/${badge.id}/review`, { as: staff, method: 'POST', json: { decision: 'publish', rarity: 'uncommon' }, headers: origin });
            assert.strictEqual(api.status, 200, api.text);
            assert.deepStrictEqual([api.json().definition.status, api.json().definition.rarity], ['published', 'uncommon']);
            assert.ok((await t.get('/workshop')).text.includes('Night Owl'));
            let r = await form(alice, `/workshop/${badge.id}/give`, { to: '@carol' });
            assert.match(decodeURIComponent(r.headers.get('location')), /Given to @carol/);
            r = await form(alice, `/workshop/${badge.id}/give`, { to: 'carol' });
            assert.match(decodeURIComponent(r.headers.get('location')), /already has it/);
            r = await form(alice, `/workshop/${badge.id}/give`, { to: 'nobody_here' });
            assert.match(decodeURIComponent(r.headers.get('location')), /Nobody is called @nobody_here/);
            const owned = (await inv.inventory(carol.subject, { own: true })).instances.find((i) => i.definition_id === badge.id);
            assert.strictEqual(owned.origin, 'granted');
            await inv.equip(carol.subject, `user:${carol.subject}`, { kind: 'network.badge', slot: 'badge', instance_id: owned.id });
            const worn = (await t.get(`/api/v1/equipped?subjects=${carol.subject}`)).json().equipped[0].slots['network.badge:badge'];
            assert.strictEqual(worn.media_id, badge.art.media_id, 'the equipped read carries the image');
            // Someone who is not the creator cannot give it.
            const notMine = await inv.grant(`user:${carol.subject}`, { definition_id: badge.id, subject: alice.subject, idempotency_key: 'ws:x:y-123', origin: 'granted' }).catch((e) => e);
            assert.strictEqual(notMine.code, 'inventory.not_issuer');
        });

        await check('the limits: 5 in review at once; the API refuses non-staff; a creator gives, never earns', async () => {
            const dave = t.network.addUser('dave');
            for (let i = 0; i < 5; i++) await inv.createDefinition(`user:${dave.subject}`, { kind: 'network.badge', name: `B${i}`, art: { media_id: 'med_01JZ0000000000000000000099' }, rarity: 'common', attributes: {}, supply_cap: 10 });
            const sixth = await inv.createDefinition(`user:${dave.subject}`, { kind: 'network.badge', name: 'B6', art: { media_id: 'med_01JZ0000000000000000000099' }, rarity: 'common', attributes: {}, supply_cap: 10 }).catch((e) => e);
            assert.strictEqual(sixth.code, 'inventory.review_queue_full');
            const notStaff = await t.get(`/api/v1/definitions/${badge.id}/review`, { as: alice, method: 'POST', json: { decision: 'publish' }, headers: origin });
            assert.deepStrictEqual([notStaff.status, notStaff.json().code], [403, 'inventory.staff_only']);
            const earned = await inv.grant(`user:${alice.subject}`, { definition_id: badge.id, subject: dave.subject, idempotency_key: 'ws:earned-0001', origin: 'earned' }).catch((e) => e);
            assert.strictEqual(earned.code, 'inventory.bad_origin');
            const live = await inv.createDefinition(`user:${dave.subject}`, { kind: 'live.hat', name: 'Nope', art: { emoji: '🎩' }, rarity: 'common', attributes: { tier: 1 } }).catch((e) => e);
            assert.strictEqual(live.code, 'inventory.not_issuer', 'a person defines only Workshop kinds');
        });
    } finally {
        await t.close();
    }
    done();
})();
