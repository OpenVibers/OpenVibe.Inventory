'use strict';

/**
 * The Workshop (ADR-054 §6, plan T21): community-made items, free. Every page works without JavaScript.
 *
 *   /workshop                 what it is, the published community badges, how to make one
 *   /workshop/new             make a badge: an image, a name, a cap, the rights you confirm (POST: multipart form)
 *   /workshop/mine            your submissions with their review state; give a published one to someone by @name
 *   /workshop/review          staff: the review queue, publish or reject with a reason
 *
 * A badge is shown to nobody until staff publish it: the review queue and its creator's own page are the only places
 * its image appears before that. Nothing is sold, bought or traded (ADR-054 §5).
 */
const express = require('express');
const Busboy = require('busboy');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');
const { html } = require('../render/html');
const { send } = require('../render/layout');
const { InventoryError, SUBJECT_RE, RARITY, WORKSHOP } = require('../inventory/store');
const { inspect, MAX_BYTES, MIN_SIDE, MAX_SIDE } = require('./image');

const KIND = 'network.badge';
const STAFF_ROLES = new Set(['admin', 'global_mod']);
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const STATUS_LABEL = { in_review: 'In review', published: 'Published', draft: 'Not accepted', retired: 'Retired' };

/** One multipart form with at most one file: → { fields, file: { buffer, truncated } | null }. */
function parseForm(req, { maxBytes }) {
    return new Promise((resolve, reject) => {
        let bb;
        try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes + 1, files: 1, fields: 10, fieldSize: 2000 } }); } catch (err) { return reject(err); }
        const fields = {};
        let file = null;
        bb.on('field', (name, value) => { fields[name] = value; });
        bb.on('file', (_name, stream) => {
            const chunks = [];
            let size = 0;
            let truncated = false;
            stream.on('data', (c) => { size += c.length; if (size <= maxBytes + 1) chunks.push(c); });
            stream.on('limit', () => { truncated = true; });
            stream.on('end', () => { file = { buffer: Buffer.concat(chunks), truncated: truncated || size > maxBytes }; });
        });
        bb.on('error', reject);
        bb.on('close', () => resolve({ fields, file }));
        req.pipe(bb);
    });
}

const img = (d, size = 64) => html`<img class="ws-img" src="https://openvibe.media/o/${d.art.media_id}" alt="" width="${size}" height="${size}" loading="lazy">`;

function createWorkshopRoutes(ctx) {
    const { config, inv, workshopMedia, people } = ctx;
    const r = asyncRouter();
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => (req.viewer && req.viewer.kind === 'user' && SUBJECT_RE.test(String(req.viewer.subject || '')) ? req.viewer.subject : null);
    const isStaff = (req) => !!(signedIn(req) && STAFF_ROLES.has(req.viewer.role));
    const login = (res, path) => res.redirect(303, `/auth/login?next=${encodeURIComponent(path)}`);
    const back = (res, path, key, value) => res.redirect(303, `${path}?${key}=${encodeURIComponent(String(value).slice(0, 200))}`);
    const notice = (req) => html`${req.query.done ? html`<p class="notice ok" role="status">${String(req.query.done).slice(0, 200)}</p>` : ''}${req.query.error ? html`<p class="notice bad" role="alert">${String(req.query.error).slice(0, 200)}</p>` : ''}`;

    // ── The Workshop ─────────────────────────────────────────
    r.get('/workshop', async (req, res) => {
        const published = await inv.workshopItems({ status: 'published', limit: 200 });
        page(req, res, {
            title: 'The Workshop',
            description: 'Badges made by people in the OpenVibe community, reviewed by staff, given free by their makers.',
            body: html`<h1>The Workshop</h1>
<p class="lede">Badges made by people in the community. Make one, staff review it, then you give it to the people you choose: your viewers, your server, the friends you played with. Every badge here is free: nothing in the Workshop is sold or traded.</p>
<p><a class="inv-btn primary" href="/workshop/new">Make a badge</a> <a class="inv-btn" href="/workshop/mine">Your badges</a></p>
<h2>How it works</h2>
<ol class="ws-steps">
  <li><strong>Make it.</strong> A square PNG or WebP, ${MIN_SIDE}–${MAX_SIDE} pixels, at most ${MAX_BYTES / 1024} KB, that you made or may use, a name, and how many may ever exist (up to ${WORKSHOP.maxCap.toLocaleString('en-US')}).</li>
  <li><strong>Staff review it.</strong> Safety, art rights and an honest rarity, before anyone else sees it. If it is not accepted you see why.</li>
  <li><strong>Give it.</strong> Type someone's name and it lands in their inventory, up to ${WORKSHOP.giftsPerDay} a day. They wear it before their name in chat and on their profile.</li>
</ol>
<h2>Community badges <span class="muted small">${published.length}</span></h2>
${published.length ? html`<ul class="inv-grid">${published.map((d) => html`<li class="inv-card r-${d.rarity}"><a class="inv-card-link" href="/items/${d.id}"><span class="inv-art inv-art-md r-${d.rarity}">${img(d)}</span><span class="inv-card-body"><span class="inv-card-name">${d.name}</span><span class="inv-rarity r-${d.rarity}">${RARITY_LABEL[d.rarity]}</span></span></a>${d.credit && d.credit.name ? html`<p class="inv-card-meta">by @${d.credit.name} · ${d.supply.issued} given</p>` : ''}</li>`)}</ul>` : html`<p class="muted">None yet. Yours could be the first.</p>`}`,
        });
    });

    // ── Make a badge ─────────────────────────────────────────
    r.get('/workshop/new', async (req, res) => {
        if (!signedIn(req)) return login(res, '/workshop/new');
        page(req, res, {
            title: 'Make a badge',
            robots: 'noindex',
            body: html`<h1>Make a badge</h1>
${notice(req)}
<form class="ws-form" method="post" action="/workshop/new" enctype="multipart/form-data">
  <label>Image <input type="file" name="image" accept="image/png,image/webp" required></label>
  <p class="muted small">A square PNG or WebP, ${MIN_SIDE} to ${MAX_SIDE} pixels on a side, at most ${MAX_BYTES / 1024} KB. It shows small, before a name: keep it simple and readable.</p>
  <label>Name <input type="text" name="name" maxlength="80" required placeholder="OG Viewer"></label>
  <label>What it means (optional) <textarea name="description" maxlength="500" rows="2" placeholder="For everyone who was in chat for the first stream."></textarea></label>
  <label>How many may ever exist <input type="number" name="supply_cap" min="1" max="${WORKSHOP.maxCap}" value="100" required></label>
  <label class="ws-check"><input type="checkbox" name="rights" value="yes" required> <span>I made this image, or I have the right to use it, and it follows the <a href="/terms">rules</a>.</span></label>
  <button type="submit" class="inv-btn primary">Send for review</button>
</form>
<p class="muted small">Staff review every badge before anyone else sees it. At most ${WORKSHOP.inReview} in review at once and ${WORKSHOP.perDay} a day.</p>`,
        });
    });

    r.post('/workshop/new', async (req, res) => {
        const me = signedIn(req);
        if (!me) return login(res, '/workshop/new');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('That form must come from this site.');
        let form;
        try { form = await parseForm(req, { maxBytes: MAX_BYTES }); } catch { return back(res, '/workshop/new', 'error', 'That upload could not be read; try again.'); }
        const f = form.fields;
        if (f.rights !== 'yes') return back(res, '/workshop/new', 'error', 'Confirm that you made the image or may use it.');
        if (!form.file || form.file.truncated) return back(res, '/workshop/new', 'error', form.file ? `A badge is at most ${MAX_BYTES / 1024} KB.` : 'Choose an image file.');
        const pic = inspect(form.file.buffer);
        if (pic.error) return back(res, '/workshop/new', 'error', pic.error);
        const cap = Number.parseInt(f.supply_cap, 10);
        try {
            const mediaId = await workshopMedia.upload({ buffer: form.file.buffer, type: pic.type, name: f.name, ownerSubject: me });
            await inv.createDefinition(`user:${me}`, {
                kind: KIND, name: String(f.name || '').trim(), description: String(f.description || '').trim() || undefined,
                art: { media_id: mediaId }, rarity: 'common', attributes: {}, supply_cap: cap,
            }, { creditName: req.viewer.username });
            return back(res, '/workshop/mine', 'done', 'Sent for review. You will see the decision here.');
        } catch (err) {
            if (err instanceof InventoryError) return back(res, '/workshop/new', 'error', err.detail || err.code);
            if (err && /OpenVibe\.Media|uploads are not set up/.test(String(err.message))) return back(res, '/workshop/new', 'error', err.message);
            throw err;
        }
    });

    // ── Your badges ──────────────────────────────────────────
    r.get('/workshop/mine', async (req, res) => {
        const me = signedIn(req);
        if (!me) return login(res, '/workshop/mine');
        const mine = await inv.workshopItems({ issuer: `user:${me}`, limit: 200 });
        page(req, res, {
            title: 'Your badges',
            robots: 'noindex',
            body: html`<h1>Your badges</h1>
${notice(req)}
<p><a class="inv-btn primary" href="/workshop/new">Make a badge</a> <a class="inv-btn" href="/workshop">The Workshop</a></p>
${mine.length ? html`<ul class="ws-mine">${mine.map((d) => html`<li class="ws-item">
  <span class="inv-art inv-art-md r-${d.rarity}">${img(d)}</span>
  <div class="ws-item-body">
    <h2>${d.name} <span class="ws-state ws-${d.status}">${STATUS_LABEL[d.status] || d.status}</span></h2>
    ${d.status === 'draft' && d.review_note ? html`<p class="notice bad">Staff's reason: ${d.review_note}</p>` : ''}
    ${d.status === 'in_review' ? html`<p class="muted">Waiting for staff. Nobody else can see it yet.</p>` : ''}
    ${d.status === 'published' ? html`<p class="muted">${d.supply.issued} of ${d.supply.cap} given · <a href="/items/${d.id}">its page</a></p>
    ${d.supply.issued < d.supply.cap ? html`<form method="post" action="/workshop/${d.id}/give" class="ws-give">
      <label>Give it to <input type="text" name="to" required maxlength="25" placeholder="@username" pattern="@?[A-Za-z0-9_]{3,24}"></label>
      <button type="submit" class="inv-btn primary">Give</button>
    </form>` : html`<p class="muted">All ${d.supply.cap} have been given.</p>`}` : ''}
  </div>
</li>`)}</ul>` : html`<p class="muted">You have not made a badge yet.</p>`}`,
        });
    });

    r.post('/workshop/:id/give', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
        const me = signedIn(req);
        if (!me) return login(res, '/workshop/mine');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('That form must come from this site.');
        const to = String((req.body || {}).to || '').trim().replace(/^@/, '');
        let subject;
        try { subject = await people.subjectOf(to); } catch { return back(res, '/workshop/mine', 'error', 'OpenVibe.Network did not answer; try again in a minute.'); }
        if (!subject) return back(res, '/workshop/mine', 'error', `Nobody is called @${to.slice(0, 24)}.`);
        try {
            const g = await inv.grant(`user:${me}`, { definition_id: String(req.params.id || ''), subject, idempotency_key: `ws:${req.params.id}:${subject}`, origin: 'granted', reason: 'Given in the Workshop' });
            return back(res, '/workshop/mine', 'done', g.created ? `Given to @${to}. It is in their inventory now.` : `@${to} already has it.`);
        } catch (err) {
            if (err instanceof InventoryError) return back(res, '/workshop/mine', 'error', err.detail || err.code);
            throw err;
        }
    });

    // ── Staff review ─────────────────────────────────────────
    r.get('/workshop/review', async (req, res) => {
        if (!signedIn(req)) return login(res, '/workshop/review');
        if (!isStaff(req)) return page(req, res, { title: 'Staff only', robots: 'noindex', body: html`<h1>Staff only</h1><p>The review queue is for OpenVibe staff.</p>` }, 403);
        const queue = await inv.workshopItems({ status: 'in_review', limit: 100 });
        page(req, res, {
            title: 'Workshop review',
            robots: 'noindex',
            body: html`<h1>Workshop review <span class="muted small">${queue.length} waiting</span></h1>
${notice(req)}
<p class="muted">Check each badge for safety (nothing hateful, sexual, violent or personal), art rights (not someone else's artwork or a brand's logo) and an honest rarity. A rejection's reason is what its creator reads.</p>
${queue.length ? html`<ul class="ws-mine">${queue.map((d) => html`<li class="ws-item">
  <span class="inv-art inv-art-lg r-common">${img(d, 96)}</span>
  <div class="ws-item-body">
    <h2>${d.name}</h2>
    <p class="muted">by ${d.credit && d.credit.name ? html`@${d.credit.name}` : d.issuer} · cap ${d.supply.cap} · sent ${String(d.created_at).slice(0, 16).replace('T', ' ')} UTC</p>
    ${d.description ? html`<p>${d.description}</p>` : ''}
    <form method="post" action="/workshop/${d.id}/review" class="ws-review">
      <label>Rarity <select name="rarity">${RARITY.map((x) => html`<option value="${x}"${x === 'common' ? ' selected' : ''}>${RARITY_LABEL[x]}</option>`)}</select></label>
      <button type="submit" name="decision" value="publish" class="inv-btn primary">Publish</button>
      <label class="ws-reason">Reason, if rejecting <input type="text" name="reason" maxlength="300" placeholder="The image is a brand's logo."></label>
      <button type="submit" name="decision" value="reject" class="inv-btn">Reject</button>
    </form>
  </div>
</li>`)}</ul>` : html`<p class="muted">Nothing waiting.</p>`}`,
        });
    });

    r.post('/workshop/:id/review', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
        if (!signedIn(req)) return login(res, '/workshop/review');
        if (!isStaff(req)) return res.status(403).type('text/plain').send('Staff only.');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('That form must come from this site.');
        const b = req.body || {};
        try {
            const d = await inv.review(`user:${req.viewer.subject}`, String(req.params.id || ''), {
                decision: String(b.decision || ''), reason: b.reason ? String(b.reason) : undefined,
                rarity: b.decision === 'publish' && b.rarity ? String(b.rarity) : undefined,
            });
            return back(res, '/workshop/review', 'done', `${d.name}: ${d.status === 'published' ? 'published' : 'not accepted'}.`);
        } catch (err) {
            if (err instanceof InventoryError) return back(res, '/workshop/review', 'error', err.detail || err.code);
            throw err;
        }
    });

    return r;
}

module.exports = { createWorkshopRoutes, parseForm, STAFF_ROLES };
