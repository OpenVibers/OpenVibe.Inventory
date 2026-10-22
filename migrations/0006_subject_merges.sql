-- phase: expand
-- Account merges (ADR-029, network.subject.merged; ADR-054 §7): one row per merge Inventory has folded, so a redelivery
-- moves nothing twice (server/inventory/subject-merge.js). The counts say what became the survivor's and what was dropped.
CREATE TABLE inventory_subject_merges (
    merge_id          text COLLATE "C" PRIMARY KEY,     -- mrg_<ULID>
    from_subject      text COLLATE "C" NOT NULL,        -- the folded-in account (now an alias of into_subject)
    into_subject      text COLLATE "C" NOT NULL,        -- the survivor
    instances         integer NOT NULL DEFAULT 0,       -- instances that moved to the survivor
    duplicates        integer NOT NULL DEFAULT 0,       -- duplicates of a non-stackable item, revoked (the oldest is kept)
    equipped          integer NOT NULL DEFAULT 0,       -- equipped slots that moved (the survivor had none there)
    equipped_dropped  integer NOT NULL DEFAULT 0,       -- equipped slots dropped (the survivor's set wins)
    merged_at         text COLLATE "C" NOT NULL         -- ISO 8601 UTC
);
