'use strict';
// The Markdown twins of inventory.openvibe.network's public pages (openvibe-shared/agent-layer), rendered by the
// same page builders the routes use (createPageRoutes().publicViews, createWorkshopRoutes().publicViews and
// render/layout.js's renderPage), so a twin cannot drift from its page: the home, the catalog (all and one kind),
// every published or retired item, the Workshop and the update log. /me is a person's own and /u/:subject is a
// person's page (noindex): neither has a twin.
const { renderPage } = require('./render/layout');

function createAgentPages(ctx, publicViews) {
    // A view that is not marked public (a person's page) has no twin.
    const twin = (page, path) => (page && page.agent === true ? { html: renderPage({ ...page, viewer: { kind: 'anonymous' }, config: ctx.config, path }) } : null);

    async function renderPublicPage(path, { query } = {}) {
        if (path === '/') return twin(await publicViews.home({ signed: false }), path);
        if (path === '/items') return twin(await publicViews.items(query && query.get('kind') ? String(query.get('kind')) : null, { signed: false }), path);
        if (path === '/updates') return twin(publicViews.updates(), path);
        if (path === '/workshop') return twin(await publicViews.workshop(), path);
        const m = /^\/items\/([^/]+)$/.exec(path);
        if (m) return twin(await publicViews.item(decodeURIComponent(m[1]), { signed: false }), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
