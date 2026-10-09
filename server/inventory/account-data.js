'use strict';

/**
 * Account export and deletion → Inventory (ADR-033, ADR-054 §7; openvibe-sdk/account-data).
 *
 *   export     the person's instances (every state), what they have equipped and their ledger rows
 *   deletion   their equipped set and instances are deleted (grant receipts go with the instances, ON DELETE CASCADE);
 *              their ledger rows stay without their subject or name, so supply counts and each item's history stay
 *              true; a creator's definitions stay, without the creator credit
 *
 * Nothing exported is a secret.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    // Equipped rows reference instances, so they go first.
    { table: 'inventory_equipped', subject: 'owner_subject', file: 'equipped.json', columns: ['kind', 'slot', 'instance_id', 'updated_at'], order: 'updated_at' },
    { table: 'inventory_instances', subject: 'owner_subject', file: 'items.json', columns: ['id', 'definition_id', 'origin', 'state', 'attributes', 'serial', 'acquired_at'], order: 'acquired_at' },
    { table: 'inventory_ledger', subject: 'owner_subject', file: 'history.json', columns: ['at', 'action', 'instance_id', 'definition_id', 'actor', 'reason'], order: 'id', erase: { anonymize: {} } },
    { table: 'inventory_definitions', subject: 'credit_subject', file: null, erase: { anonymize: { credit_name: null } } },
];

/** A ledger row the person acted in (an equip they made) keeps the row and loses their name. */
async function extraErase(t, subjects, counts) {
    counts.add(counts.retained, 'tombstones', await t.exec("UPDATE inventory_ledger SET actor = 'user:deleted' WHERE actor = ANY($1::text[])", [subjects.map((x) => `user:${x}`)]));
}

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'inventory', tables: TABLES, extraErase, log });
}

module.exports = { create, TABLES, TOPICS };
