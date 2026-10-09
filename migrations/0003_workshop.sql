-- phase: expand
-- The Workshop v1 (ADR-054 §6 amendment, Contracts 0.124.0): a kind may be a Workshop kind, whose definitions any
-- person may submit (issued by and credited to them, in review until staff publish them). A rejected submission goes
-- back to draft with the reviewer's note, which only its creator sees. Additive.
ALTER TABLE inventory_kinds ADD COLUMN IF NOT EXISTS workshop boolean NOT NULL DEFAULT false;
ALTER TABLE inventory_definitions ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE inventory_definitions ADD COLUMN IF NOT EXISTS reviewed_by text COLLATE "C";
ALTER TABLE inventory_definitions ADD COLUMN IF NOT EXISTS reviewed_at text COLLATE "C";
CREATE INDEX IF NOT EXISTS inventory_definitions_review ON inventory_definitions (status, created_at) WHERE status = 'in_review';
