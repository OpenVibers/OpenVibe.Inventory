'use strict';

/**
 * What OpenVibe.Inventory registers at boot (ADR-054 §8), idempotently:
 *   server/data/kinds.json              the kinds (contracts with renderers); an existing kind is updated in place
 *   server/data/live-definitions.json   Live's cosmetics catalog as definitions issued by service:live, found again by their
 *                                       alias (Live's item id); a definition already there is left as it is
 * A boot that changes nothing writes nothing.
 */
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const LIVE = 'service:live';

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
    return { kinds: kinds.length, definitions: made };
}

module.exports = { seed, LIVE };
