'use strict';

/**
 * Account export and deletion → Inventory (ADR-033, ADR-054 §7; openvibe-sdk/account-data).
 *
 *   export     the person's instances (every state), what they have equipped and their ledger rows
 *   deletion   their equipped set and instances are deleted (grant receipts go with the instances, ON DELETE CASCADE);
 *              their ledger rows stay without their subject or name, so supply counts and each item's history stay
 *              true; a creator's definitions stay, without the creator credit
 *   Workshop   the badges a person made are exported (made.json); on deletion each passes to its kind's issuer, without
 *              the credit or the review note, and is retired (nobody gives it any more; the owned ones stay), and the
 *              creator's gift receipts lose their name
 *
 * Nothing exported is a secret.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    // Equipped rows reference instances, so they go first.
    { table: 'inventory_equipped', subject: 'owner_subject', file: 'equipped.json', columns: ['kind', 'slot', 'instance_id', 'updated_at'], order: 'updated_at' },
    { table: 'inventory_instances', subject: 'owner_subject', file: 'items.json', columns: ['id', 'definition_id', 'origin', 'state', 'attributes', 'serial', 'acquired_at'], order: 'acquired_at' },
    { table: 'inventory_ledger', subject: 'owner_subject', file: 'history.json', columns: ['at', 'action', 'instance_id', 'definition_id', 'actor', 'reason'], order: 'id', erase: { anonymize: {} } },
    { table: 'inventory_definitions', subject: 'credit_subject', file: 'made.json', columns: ['id', 'kind', 'name', 'description', 'status', 'supply_cap', 'supply_issued', 'created_at', 'published_at'], order: 'created_at', erase: { anonymize: { credit_name: null } } },
];

/** A ledger row the person acted in (an equip they made) keeps the row and loses their name. */
async function extraErase(t, subjects, counts) {
    const people = subjects.map((x) => `user:${x}`);
    counts.add(counts.retained, 'tombstones', await t.exec("UPDATE inventory_ledger SET actor = 'user:deleted' WHERE actor = ANY($1::text[])", [people]));
    // Their Workshop items: the kind's issuer takes them over, retired, without the review note (ADR-054 §6).
    counts.add(counts.retained, 'workshop items', await t.exec(`UPDATE inventory_definitions d SET issuer = k.issuer, review_note = NULL, reviewed_by = NULL,
        status = CASE WHEN d.status = 'retired' THEN d.status ELSE 'retired' END FROM inventory_kinds k WHERE k.id = d.kind AND d.issuer = ANY($1::text[])`, [people]));
    counts.add(counts.retained, 'gift receipts', await t.exec("UPDATE inventory_grants SET issuer = 'user:deleted' WHERE issuer = ANY($1::text[])", [people]));
    await t.exec("UPDATE inventory_definitions SET reviewed_by = NULL WHERE reviewed_by = ANY($1::text[])", [people]);
}

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'inventory', tables: TABLES, extraErase, log });
}

module.exports = { create, TABLES, TOPICS };
