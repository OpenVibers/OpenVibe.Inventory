'use strict';

// One translation for browser links, redirects, metadata and discovery. API paths retain their shape.
function urls(config) {
    const base = new URL(config.baseUrl);
    const prefix = base.pathname.replace(/\/+$/, '');
    function path(value = '/') {
        if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return value;
        if (prefix && (value === `${prefix}.md` || value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`))) return value;
        if (!prefix) return value;
        const match = /^([^?#]*)(.*)$/.exec(value);
        let route = match[1];
        if (route === '/items') route = '/all';
        else if (route.startsWith('/items/')) route = route.slice(6);
        else if (route === '/me') route = '/';
        return prefix + (route === '/' ? '' : route) + match[2];
    }
    const absolute = (value = '/') => new URL(path(value), base.origin).href;
    // Shared components return HTML, not link objects. Translate only their URL attributes.
    const html = (value) => String(value).replace(/\b(href|src|action)=(['"])(\/(?!\/)[^'"]*)\2/g,
        (_all, attr, quote, value) => `${attr}=${quote}${path(value)}${quote}`);
    return { path, absolute, html, prefix, origin: base.origin };
}

function legacyPage(path) {
    return path === '/' || /^\/(?:items(?:\/[^/]+)?|me|workshop(?:\/.*)?|u\/[^/]+|updates)\/?$/.test(path);
}
module.exports = { urls, legacyPage };
