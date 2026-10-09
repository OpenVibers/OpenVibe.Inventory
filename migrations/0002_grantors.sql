-- phase: expand
-- ADR-054 §3 amendment (Contracts 0.123.0): a definition may name grantors, other services or apps its issuer lets
-- grant that one item (OpenVibe.Quest giving some of Live's hats as quest rewards). Grant only: defining, editing,
-- consuming and revoking stay the issuer's. Additive; an older release never reads the column.
ALTER TABLE inventory_definitions ADD COLUMN IF NOT EXISTS grantors jsonb NOT NULL DEFAULT '[]'::jsonb;
