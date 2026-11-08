'use strict';
const { urls } = require('../urls');

// SDK 0.94 fixes its cookie names and /auth paths. Adapt its Express boundary so
// Inventory never reads or writes the account hub's root session or flow cookies.
function scopedSession(config) {
    const url = urls(config);
    return (req, res, next) => {
        if (!req.inventoryScoped) return next();
        const incoming = req.cookies || {};
        req.cookies = Object.fromEntries(Object.entries(incoming)
            .filter(([name]) => name.startsWith('inventory_ov_'))
            .map(([name, value]) => [name.slice('inventory_'.length), value]));
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
