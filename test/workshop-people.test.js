'use strict';
// The Workshop's "@name" → subject lookup against OpenVibe.Network's real answer (identity.subject-projection@1, whose
// subject is a subject-ref { type, id }). Until 2026-11-06 it read subject_id, which Network never sends, so every gift
// to an @name answered "nobody by that name". workshop.test.js stubs this module, so the shape is tested here.
const assert = require('assert');
const { createPeople } = require('../server/workshop/people');

const SUBJECT = 'usr_01M1PZ8C7RJGH2J1ATMPQ5B71F';
function fakeNetwork(answers) {
    const asked = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/oauth/token') return new Response(JSON.stringify({ access_token: 'svc', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        const name = u.searchParams.get('username');
        asked.push(name);
        const a = answers[name.toLowerCase()];
        if (!a) return new Response(JSON.stringify({ code: 'identity.subject_not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, asked };
}
const config = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'inventory', clientSecret: 'x' } };
const person = (over = {}) => ({ subject: { type: 'user', id: SUBJECT }, username: 'Quinn', display_name: 'Quinn', avatar_url: null, banned: false, ...over });

(async () => {
    const net = fakeNetwork({ quinn: person(), 'a.b-c': person({ username: 'a.b-c' }), gone: person({ deleted: true }), banned: person({ banned: true }) });
    const people = createPeople({ config, fetchImpl: net.fetchImpl });

    assert.strictEqual(await people.subjectOf('@Quinn'), SUBJECT, 'the subject-ref id, any case, with or without the @');
    assert.strictEqual(await people.subjectOf('a.b-c'), SUBJECT, "Network's own name rule: dots and dashes are names too");
    assert.strictEqual(await people.subjectOf('nobody'), null, 'Network does not know the name');
    assert.strictEqual(await people.subjectOf('gone'), null, 'a deleted account is nobody to give to');
    assert.strictEqual(await people.subjectOf('banned'), null, 'nor a banned one');
    assert.strictEqual(await people.subjectOf('bad name!'), null, 'a name Network would refuse is not asked');
    assert.ok(!net.asked.includes('bad name!'));
    console.log('workshop people: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
