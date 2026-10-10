-- phase: expand
-- OpenVibe.Inventory: item pages in OpenVibe.Search (server/search-index.js, openvibe-publishing/search-feed).
-- inventory_index_revisions is the index sequencer: the last revision and content hash Search was sent for each item
-- page, so an unchanged page is never sent twice. The inventory.index_document.* events go through the existing
-- event_outbox (0001), in the same transaction as the revision that produced them.

CREATE TABLE IF NOT EXISTS inventory_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);
