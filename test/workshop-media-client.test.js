'use strict';

/** Workshop Media authentication without opening a socket. */
const assert = require('assert');
const { load } = require('../server/config');
const { createWorkshopMedia } = require('../server/workshop/media');

const upload = { buffer: Buffer.from('image'), type: 'image/png', name: 'badge', ownerSubject: 'usr_test' };
const id = `med_${'0'.repeat(26)}`;

(async () => {
    const config = load({
        OV_NETWORK_INTERNAL_URL: 'http://network.test',
        OV_MEDIA_INTERNAL_URL: 'http://media.test',
        OV_OAUTH_CLIENT_ID: 'inventory',
        OV_OAUTH_CLIENT_SECRET: 'inventory-secret',
    });
    const requests = [];
    const fetchImpl = async (url, opts) => {
        requests.push({ url, opts });
        if (url === 'http://network.test/oauth/token') {
            return { ok: true, json: async () => ({ access_token: 'svc-media', token_type: 'Bearer', expires_in: 300 }) };
        }
        return { ok: true, json: async () => url.endsWith('/objects') ? { id } : {} };
    };
    const media = createWorkshopMedia({ config, fetchImpl });
    assert.strictEqual(media.enabled(), true);
    assert.strictEqual(requests.length, 0, 'the token client is lazy');
    assert.strictEqual(await media.upload(upload), id);

    const tokenRequests = requests.filter((r) => r.url.endsWith('/oauth/token'));
    const mediaRequests = requests.filter((r) => r.url.startsWith('http://media.test/'));
    assert.strictEqual(tokenRequests.length, 1, 'the token is cached for the upload');
    assert.strictEqual(tokenRequests[0].opts.method, 'POST');
    const form = new URLSearchParams(tokenRequests[0].opts.body);
    assert.strictEqual(form.get('grant_type'), 'client_credentials');
    assert.strictEqual(form.get('audience'), 'openvibe.media');
    assert.strictEqual(form.get('client_id'), 'inventory');
    assert.strictEqual(mediaRequests.length, 3);
    for (const request of mediaRequests) assert.strictEqual(request.opts.headers.Authorization, 'Bearer svc-media');
    assert.strictEqual(mediaRequests[0].opts.headers['X-OV-Subject'], upload.ownerSubject);

    const noSecretRequests = [];
    const noSecret = createWorkshopMedia({
        config: load({ OV_OAUTH_CLIENT_SECRET: '' }),
        fetchImpl: async (...args) => { noSecretRequests.push(args); throw new Error('unexpected request'); },
    });
    assert.strictEqual(noSecret.enabled(), false);
    await assert.rejects(noSecret.upload(upload), /not set up yet \(OV_OAUTH_CLIENT_SECRET\)/);
    assert.strictEqual(noSecretRequests.length, 0);

    const failedRequests = [];
    const failed = createWorkshopMedia({
        config,
        fetchImpl: async (url) => { failedRequests.push(url); throw new Error('inventory-secret'); },
        log: { warn() {} },
    });
    const error = await failed.upload(upload).catch((err) => err);
    assert.match(error.message, /OpenVibe\.Media did not answer \(service token unavailable\)/);
    assert.ok(!error.message.includes('inventory-secret'));
    assert.deepStrictEqual(failedRequests, ['http://network.test/oauth/token']);

    console.log('workshop Media client: passed');
})().catch((err) => { console.error(err); process.exit(1); });
