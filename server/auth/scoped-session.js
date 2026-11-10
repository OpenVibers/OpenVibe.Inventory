'use strict';
const { urls } = require('../urls');

// SDK 0.94 fixes its cookie names and /auth paths. Adapt its Express boundary so
// Inventory writes only its own cookies and never borrows hub refresh or flow cookies.
// The mounted pages may read the hub access token: the SSO verifier still requires
// Inventory's configured issuer, audience, expiry and a person session.
function scopedSession(config) {
    const url = urls(config);
    return (req, res, next) => {
        if (!req.inventoryScoped) return next();
        const incoming = req.cookies || {};
        req.cookies = Object.fromEntries(Object.entries(incoming)
            .filter(([name]) => name.startsWith('inventory_ov_'))
            .map(([name, value]) => [name.slice('inventory_'.length), value]));
        // One site, one viewer. Do not decode claims or broaden the accepted audience:
        // optionalAuth verifies this token exactly like an Inventory-issued session.
        if (incoming.ov_token) {
            req.cookies.ov_token = incoming.ov_token;
            // A previous Inventory account must not replace the hub viewer on a 401.
            delete req.cookies.ov_refresh;
        }
        const cookie = res.cookie.bind(res);
        const clearCookie = res.clearCookie.bind(res);
        const nameFor = (name) => name.startsWith('ov_') ? `inventory_${name}` : name;
        const options = (opts) => ({ ...opts, domain: undefined, path: url.prefix });
        res.cookie = (name, value, opts) => cookie(nameFor(name), value, options(opts));
        // Express clearCookie calls res.cookie; pass the original name to avoid renaming twice.
        res.clearCookie = (name, opts) => clearCookie(name, options(opts));
        next();
    };
}
module.exports = { scopedSession };
