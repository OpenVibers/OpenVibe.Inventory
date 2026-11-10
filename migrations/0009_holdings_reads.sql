-- phase: expand
-- The common per-person owned scan and stable newest boundary; the existing owner index
-- still serves reads that include consumed and revoked instances.
CREATE INDEX inventory_instances_owned_page ON inventory_instances (owner_subject, acquired_at DESC, id DESC)
    INCLUDE (definition_id) WHERE state = 'owned';
CREATE INDEX inventory_instances_owned_stack ON inventory_instances (owner_subject, definition_id, acquired_at DESC, id DESC)
    WHERE state = 'owned';
CREATE INDEX inventory_definitions_name_sort ON inventory_definitions ((lower(name)) COLLATE "C", id);
