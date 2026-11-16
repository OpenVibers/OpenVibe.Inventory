'use strict';

/**
 * What OpenVibe.Inventory registers at boot (ADR-054 §8), idempotently:
 *   server/data/kinds.json              the kinds (contracts with renderers); an existing kind is updated in place
 *   server/data/live-definitions.json   Live's cosmetics catalog as definitions issued by service:live, found again by their
 *                                       alias (Live's item id); a definition already there is left as it is
 *   server/data/live-grantors.json      the services Live lets grant some of its items (ADR-054 §3), set on the definition
 *                                       whenever the file and the database differ (Quest's quest rewards)
 *   server/data/live-art.json           each Live item's drawn art (2026-11-16; the owner: item icons as emoji look cheap):
 *                                       a Media object drawn in the house item style on openvibe.design, set as the
 *                                       definition's art.media_id whenever the file and the database differ; its emoji
 *                                       and CSS token stay beside it, for whatever cannot show a picture
 * A boot that changes nothing writes nothing.
 */
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const LIVE = 'service:live';
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

async function seed(inv, { log = console } = {}) {
    const { kinds } = require(path.join(DATA, 'kinds.json'));
    for (const k of kinds) await inv.upsertKind(k);
    const { definitions } = require(path.join(DATA, 'live-definitions.json'));
    let made = 0;
    for (const d of definitions) {
        if (await inv.byAlias(LIVE, d.alias)) continue;
        await inv.createDefinition(LIVE, { kind: d.kind, name: d.name, description: d.description || undefined, art: d.art, rarity: d.rarity, attributes: d.attributes, aliases: [d.alias] }, { status: 'published' });
        made++;
    }
    if (made) log.log(`[OpenVibe.Inventory] seeded ${made} of Live's cosmetics as definitions`);
    const { grantors } = require(path.join(DATA, 'live-grantors.json'));
    let granting = 0;
    for (const [alias, list] of Object.entries(grantors)) {
        const d = await inv.byAlias(LIVE, alias);
        if (!d || JSON.stringify(d.grantors || []) === JSON.stringify(list)) continue;
        await inv.updateDefinition(LIVE, d.id, { grantors: list });
        granting++;
    }
    if (granting) log.log(`[OpenVibe.Inventory] set the grantors of ${granting} of Live's items`);
    const { art } = require(path.join(DATA, 'live-art.json'));
    let drawn = 0;
    for (const [alias, a] of Object.entries(art || {})) {
        if (!a || !MEDIA_ID.test(String(a.media_id || ''))) continue;
        const d = await inv.byAlias(LIVE, alias);
        if (!d || (d.art && d.art.media_id === a.media_id)) continue;
        await inv.updateDefinition(LIVE, d.id, { art: { ...(d.art || {}), media_id: a.media_id } });
        drawn++;
    }
    if (drawn) log.log(`[OpenVibe.Inventory] set the drawn art of ${drawn} of Live's items`);
    return { kinds: kinds.length, definitions: made, grantors: granting, art: drawn };
}

module.exports = { seed, LIVE };
