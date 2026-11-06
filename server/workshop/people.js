'use strict';

/**
 * Who a creator means by "@name" when they give a Workshop item: OpenVibe.Network's
 * GET /internal/identity/resolve?username=… (a person's current name, any case), read with this service's own client
 * credentials for audience openvibe.network and identity.subject.resolve. Only the subject is used.
 *
 *   subjectOf(name) → usr_… | null   (null: nobody by that name; throws when the Network cannot answer)
 */
const { serviceAuth } = require('openvibe-contracts');

// Network's own rule for a name (server/identity/subjects.js resolveUsername): 1-40 of letters, digits, _ . and -.
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createPeople({ config, fetchImpl = globalThis.fetch }) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve',
        fetchImpl,
    });

    async function subjectOf(name) {
        const n = String(name || '').trim().replace(/^@/, '');
        if (!NAME_RE.test(n)) return null;
        const res = await fetchImpl(`${base}/internal/identity/resolve?username=${encodeURIComponent(n)}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
            signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`OpenVibe.Network answered ${res.status}`);
        const body = await res.json().catch(() => ({}));
        // identity.subject-projection@1: subject is a subject-ref { type, id }; only a person (type user) can be given an item.
        // (2026-11-06: this read subject_id, which Network never sends, so every @name answered "nobody by that name".)
        const ref = body && body.subject;
        const subject = ref && typeof ref === 'object' && ref.type === 'user' ? ref.id : null;
        if (body && (body.banned || body.deleted)) return null;
        return SUBJECT_RE.test(String(subject || '')) ? subject : null;
    }

    return { subjectOf };
}

module.exports = { createPeople };
