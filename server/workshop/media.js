'use strict';

/**
 * Workshop images in OpenVibe.Media: Inventory's own tenant (`inventory`, its app key in INVENTORY_MEDIA_APP_KEY),
 * a public `asset` object per badge, served by Media at https://openvibe.media/o/<med_…>. The badge is shown to
 * nobody until staff publish it (the pages never link an image of an item in review except to its creator and to
 * staff); a rejected or retired item keeps its object so the review record stays whole.
 *
 *   upload({ buffer, type, name, ownerSubject }) → med_… id   (init → content → complete; throws with a short reason)
 */
function createWorkshopMedia({ config, fetchImpl = globalThis.fetch, log = console }) {
    const base = () => `${String(config.media.url).replace(/\/+$/, '')}/api/v2/${encodeURIComponent(config.media.app)}/objects`;
    const enabled = () => Boolean(config.media.appKey);

    async function call(path, { method = 'POST', json, body, headers = {} } = {}) {
        const h = { Accept: 'application/json', Authorization: `Bearer ${config.media.appKey}`, ...headers };
        let payload = body;
        if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
        let res;
        try {
            res = await fetchImpl(`${base()}${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(config.media.timeoutMs) });
        } catch (err) {
            log.warn('[Workshop] OpenVibe.Media did not answer:', (err && err.name) || '');
            throw new Error('OpenVibe.Media did not answer; try again in a minute.');
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const p = (data && (data.problem || data)) || {};
            throw new Error(`OpenVibe.Media refused the image (${p.code || res.status}).`);
        }
        return data || {};
    }

    async function upload({ buffer, type, name, ownerSubject }) {
        if (!enabled()) throw new Error('Image uploads are not set up yet (INVENTORY_MEDIA_APP_KEY).');
        // The same call shape as OpenVibe.MediaHub's client: the owner in X-OV-Subject, a printable-ASCII filename label.
        const filename = String(name || 'badge').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim().slice(0, 100) || 'badge';
        const init = await call('', { headers: { 'X-OV-Subject': ownerSubject }, json: { kind: 'asset', visibility: 'public', size_bytes: buffer.length, mime_type: type, filename: `${filename}.${type === 'image/png' ? 'png' : 'webp'}` } });
        const id = (init.object && init.object.id) || init.id;
        if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw new Error('OpenVibe.Media answered without an object id.');
        await call(`/${id}/content`, { method: 'PUT', body: buffer, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) } });
        await call(`/${id}/complete`, { json: {} });
        return id;
    }

    return { upload, enabled };
}

module.exports = { createWorkshopMedia };
