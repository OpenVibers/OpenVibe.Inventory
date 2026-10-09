# Changelog

What changed in OpenVibe.Inventory, newest first. Each site also publishes its patch notes at /updates.

## 0.4.1 — 2026-10-09

- Workshop takedown (ADR-054 §6): `/workshop/review` lists the published community badges. Staff can retire one (nobody
  gives it any more) or retire it and revoke every copy (taken off whoever wears it, each owner told through
  `inventory.item.revoked`). Both need a reason, which goes to the ledger.

## 0.4.0 — 2026-10-09

- **The Workshop** (ADR-054 §6 amendment, openvibe-contracts 0.124.0): community badges, free.
  - **The kind:** `network.badge`, the first Workshop kind (`migrations/0003_workshop.sql`).
  - **Making one:** `/workshop/new` takes the image as a no-JavaScript multipart upload, checked by its header bytes
    and stored in OpenVibe.Media (`INVENTORY_MEDIA_APP_KEY`).
  - **Review:** staff review at `/workshop/review` and `POST /api/v1/definitions/:id/review` (publish with a rarity, or
    reject with a reason).
  - **Giving:** creators give their badges by `@name` from `/workshop/mine`, through the Network's username lookup.
  - **Rendering:** the equipped read carries `media_id`.
  - **Account data:** export includes `made.json`; on deletion a creator's badges pass to the kind's issuer, retired.

## 0.3.0 — 2026-10-09

- **Grantors** (ADR-054 §3 amendment, openvibe-contracts 0.123.0): a definition may name the services or apps that may
  grant it. A grantor only grants (earned or granted, idempotent per its own key, within the cap), and the ledger and
  the `inventory.item.granted` event record it as the actor with the issuer kept. The issuer sets and clears the list
  with `PATCH /definitions/:id`; a person is never a grantor (`migrations/0002_grantors.sql`).
- Live lets OpenVibe.Quest give six common items as quest rewards: Sparkle, Hearts, Basic Cap, Fire Name, Ice Name
  and Rainbow Name (`server/data/live-grantors.json`, set at boot). Their item pages say how to get them.
- The public reads answer every origin (#4), and the sitemap and llms.txt list every item, kind and the public API (#3).

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
