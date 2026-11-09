-- phase: expand
-- Reviewed listings and durable purchase reservations. Network still holds OpenCoins; Billing authorizes every spend.
CREATE TABLE inventory_store_listings (
    definition_id text COLLATE "C" PRIMARY KEY REFERENCES inventory_definitions(id),
    issuer text NOT NULL,
    prices jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('in_review', 'published', 'rejected')),
    reviewed_by text,
    updated_at text NOT NULL
);
CREATE TABLE inventory_store_purchases (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C",
    definition_id text COLLATE "C" NOT NULL REFERENCES inventory_definitions(id),
    idempotency_key text NOT NULL,
    currency text NOT NULL CHECK (currency IN ('vibes', 'coins')),
    amount bigint NOT NULL CHECK (amount > 0),
    name text NOT NULL,
    issuer text NOT NULL,
    serial bigint,
    instance_id text COLLATE "C",
    payment_id text,
    created_at text NOT NULL,
    UNIQUE(subject, idempotency_key),
    UNIQUE(subject, definition_id)
);
