'use strict';
const contracts = require('openvibe-contracts');
const origins = new Set();
for (const service of contracts.services.manifests) {
    for (const domain of service.domains || []) {
        if (/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(domain)) {
            origins.add(`https://${domain}`); origins.add(`https://www.${domain}`);
        }
    }
}
module.exports = (req, res, next) => {
    if (!/^\/(?:store(?:\/[^/]+(?:\/(?:buy|list|review))?|\/purchases\/[^/]+)?|me\/(?:items|equipped))$/.test(req.path)) return next();
    res.vary('Origin');
    const origin = req.get('origin');
    if (origins.has(origin)) res.set({ 'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Max-Age': '600' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
};
