'use strict';
// What inventory.openvibe.network tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the public catalog and item API at /api/v1, and the public
// catalog pages. There is no documentation page of its own (the API is described in the README), so `docs` is omitted.
module.exports = {
    id: 'inventory',
    name: 'OpenVibe.Inventory',
    purpose: 'One inventory for your whole OpenVibe account: name effects, particles, hats, voices and badges, earned across the network and worn in chat, on stream overlays and on your profile.',
    home: 'https://inventory.openvibe.network',
    site: 'inventory.openvibe.network',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
