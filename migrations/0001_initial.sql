-- phase: expand
-- OpenVibe.Inventory (ADR-054): item kinds, definitions, instances, the equipped set and the append-only ledger, plus
-- the grant receipts, the event outbox and the account-data receipts. Nothing written here is ever a credential, a key
-- or a token. Money never enters this database: nothing is sold, bought, traded or converted (ADR-054 §5).

-- A kind: what its items carry (attribute_schema, a JSON Schema), where one can be equipped (slots) and which surfaces
-- render it (inventory.kind@1). issuer owns the kind's namespace (service:live for live.*).
CREATE TABLE inventory_kinds (
    id               text COLLATE "C" PRIMARY KEY,           -- live.name_effect
    name             text NOT NULL,
    description      text,
    slots            jsonb NOT NULL DEFAULT '[]',
    surfaces         jsonb NOT NULL DEFAULT '[]',
    attribute_schema jsonb NOT NULL DEFAULT '{"type":"object"}',
    stackable        boolean NOT NULL DEFAULT false,
    issuer           text COLLATE "C" NOT NULL,
    created_at       text COLLATE "C" NOT NULL,
    updated_at       text COLLATE "C" NOT NULL
);

-- A definition: one item of a kind (inventory.definition@1).
CREATE TABLE inventory_definitions (
    id            text COLLATE "C" PRIMARY KEY,              -- itd_<ULID>
    kind          text COLLATE "C" NOT NULL REFERENCES inventory_kinds(id),
    name          text NOT NULL,
    description   text,
    art           jsonb NOT NULL,
    rarity        text NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
    attributes    jsonb NOT NULL DEFAULT '{}',
    issuer        text COLLATE "C" NOT NULL,                 -- service:live | app:app_… | user:usr_…
    supply_cap    integer CHECK (supply_cap IS NULL OR supply_cap > 0),
    supply_issued integer NOT NULL DEFAULT 0 CHECK (supply_issued >= 0),
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'retired')),
    credit_subject text COLLATE "C",
    credit_name   text,
    created_at    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL,
    published_at  text COLLATE "C",
    CHECK (supply_cap IS NULL OR supply_issued <= supply_cap)
);
CREATE INDEX inventory_definitions_kind ON inventory_definitions (kind, status, name);
CREATE INDEX inventory_definitions_issuer ON inventory_definitions (issuer, created_at DESC);

-- Earlier ids of a definition, per issuer (Live's fx_rainbow): how Live and the migration find an item.
CREATE TABLE inventory_definition_aliases (
    issuer        text COLLATE "C" NOT NULL,
    alias         text COLLATE "C" NOT NULL,
    definition_id text COLLATE "C" NOT NULL REFERENCES inventory_definitions(id) ON DELETE CASCADE,
    PRIMARY KEY (issuer, alias)
);

-- An instance: one definition owned by one person (inventory.instance@1).
CREATE TABLE inventory_instances (
    id            text COLLATE "C" PRIMARY KEY,              -- inv_<ULID>
    definition_id text COLLATE "C" NOT NULL REFERENCES inventory_definitions(id),
    owner_subject text COLLATE "C" NOT NULL,                 -- usr_…
    origin        text NOT NULL CHECK (origin IN ('granted', 'earned', 'migrated')),
    state         text NOT NULL DEFAULT 'owned' CHECK (state IN ('owned', 'consumed', 'revoked')),
    attributes    jsonb NOT NULL DEFAULT '{}',
    serial        integer CHECK (serial IS NULL OR serial > 0),
    acquired_at   text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL
);
CREATE INDEX inventory_instances_owner ON inventory_instances (owner_subject, acquired_at DESC, id DESC);
CREATE INDEX inventory_instances_definition ON inventory_instances (definition_id, owner_subject) WHERE state = 'owned';

-- One grant per (issuer, idempotency key): a repeat answers the instance already granted.
CREATE TABLE inventory_grants (
    issuer          text COLLATE "C" NOT NULL,
    idempotency_key text COLLATE "C" NOT NULL,
    instance_id     text COLLATE "C" NOT NULL REFERENCES inventory_instances(id) ON DELETE CASCADE,
    created_at      text COLLATE "C" NOT NULL,
    PRIMARY KEY (issuer, idempotency_key)
);

-- What a person has equipped: one instance per (kind, slot).
CREATE TABLE inventory_equipped (
    owner_subject text COLLATE "C" NOT NULL,
    kind          text COLLATE "C" NOT NULL,
    slot          text COLLATE "C" NOT NULL,
    instance_id   text COLLATE "C" NOT NULL REFERENCES inventory_instances(id) ON DELETE CASCADE,
    updated_at    text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner_subject, kind, slot)
);
CREATE INDEX inventory_equipped_instance ON inventory_equipped (instance_id);

-- Every movement, append-only: granted, earned, migrated, equipped, unequipped, consumed, revoked, erased. A deleted
-- account's rows keep their counts and lose their subject (ADR-054 §7).
CREATE TABLE inventory_ledger (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at            text COLLATE "C" NOT NULL,
    action        text NOT NULL,
    owner_subject text COLLATE "C",
    instance_id   text COLLATE "C",
    definition_id text COLLATE "C",
    actor         text COLLATE "C" NOT NULL,                 -- user:usr_… | service:… | app:app_…
    reason        text,
    detail        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX inventory_ledger_owner ON inventory_ledger (owner_subject, id DESC);
CREATE INDEX inventory_ledger_instance ON inventory_ledger (instance_id, id);

-- openvibe-sdk service outbox (inventory.item.*, inventory.definition.published).
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;

-- openvibe-sdk/account-data receipts (ADR-033): a redelivered export or deletion changes nothing.
CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);
