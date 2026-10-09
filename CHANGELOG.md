# Changelog

What changed in OpenVibe.Inventory, newest first. Each site also publishes its patch notes at /updates.

## 0.2.0 — 2026-10-09

- **The inventory (ADR-054, plan T21 step 2).**
  - **Storage:** kinds, definitions, instances, the equipped set and an append-only ledger
    (`migrations/0001_initial.sql`).
  - **Code:** the domain in `server/inventory/store.js`, the API in `server/http/api.js` (seven capabilities) and the
    pages: home, `/items`, `/items/:id`, `/me` and `/u/:subject`.
  - **Seed:** Live's five kinds and 70 cosmetics at boot.
  - **Events and account data:** `inventory.*` events through the outbox, and account export and deletion at
    `/internal/events`.
  - **Migration:** `scripts/import-live.js` moves Live's unlocks and equipped slots here and verifies them row for row.
  - **The money rule:** no route or column sells, buys, trades or converts an item, and a test holds that.

## 0.1.0 — 2026-10-08

- **First release:** the service starts from the OpenVibe skeleton — sign-in with OpenVibe.Network (OAuth 2 + PKCE), server-rendered pages through the OpenVibe Frame, the `/api/v1` mount with per-caller limits, crawl artifacts, PostgreSQL migrations, the deploy files and the test suite.
