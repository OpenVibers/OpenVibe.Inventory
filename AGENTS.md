# AGENTS.md — OpenVibe.Inventory

## Project Overview

OpenVibe.Inventory is the network-wide inventory for one OpenVibe account (ADR-054): the item kinds a surface can
render, the definitions an issuer publishes, the instances a person owns, the equipped set, the ledger, the community
Workshop and the reviewed cosmetic store. One inventory for every OpenVibe site, the way Steam's works across games.

- **Site:** `openvibe.my/inventory` (base-path aware; API host `inventory.openvibe.network`) · **Port:** 5030 ·
  **Service id:** `inventory` · **Env prefix:** `INVENTORY`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9
  for shared limits.
- **Read first:** [README.md](README.md), [docs/store.md](docs/store.md), [STATUS.json](STATUS.json), ADR-054 in
  OpenVibe.Contracts.

**Network context:** subjects (`usr_…`), usernames, tokens, JWKS and roles are OpenVibe.Network. Image bytes are
OpenVibe.Media (a Workshop image is uploaded to Inventory's Media tenant and referenced by `med_` id). Events are
published through the SDK outbox to OpenVibe.Events; account export/deletion arrives there at `/internal/events`.
Money is OpenVibe.Billing: the store snapshots a reviewed price, Billing authorizes the spend, and Inventory matches
Billing's payment before granting. Inventory never moves money itself.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:5030 (base path from PUBLIC_URL/BASE_URL)
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite, mocked Network/Media/Billing
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- holdings           # only test files whose name contains the word
npm test -- --strict           # a skipped test fails the run
node --check <file.js>         # syntax check (no linter configured)
```

`test/run.js` uses `openvibe-shared/test-runner`; tests use fixtures and never reach the internet. No build step:
pages are server-rendered and assets live under [public/](public/).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry retention, the outbox relay and the two account
  subscriptions; graceful stop in `createLifecycle()`. `INVENTORY_DRILL` keeps boot-time work off.
- **App factory:** [server/app.js](server/app.js) — CSP, SSO, `/auth`, `/internal/events`, the `/shared` + static
  mounts, `/api/v1`, discovery/agent twins, pages, 404/error handler.
- **Config and URLs:** [server/config.js](server/config.js) (`load(env)` is pure), [server/urls.js](server/urls.js)
  (the one base-path translation for links, redirects, metadata and discovery — API paths keep their shape).
- **Model/store:** [server/inventory/store.js](server/inventory/store.js) (kinds, definitions, instances, grants,
  equipped, ledger, subject merges), [server/inventory/holdings.js](server/inventory/holdings.js) (stacked public/own
  holdings and cursors), [server/inventory/commerce.js](server/inventory/commerce.js) (store, review, orders,
  Billing), [server/inventory/seed.js](server/inventory/seed.js), [server/inventory/account-data.js](server/inventory/account-data.js).
  Seed data: [server/data/kinds.json](server/data/kinds.json), [server/data/live-definitions.json](server/data/live-definitions.json),
  [server/data/live-grantors.json](server/data/live-grantors.json).
- **Workshop:** [server/workshop/pages.js](server/workshop/pages.js), [server/workshop/people.js](server/workshop/people.js),
  [server/workshop/media.js](server/workshop/media.js), [server/workshop/image.js](server/workshop/image.js); upload JS
  [public/js/workshop-upload.js](public/js/workshop-upload.js).
- **HTTP:** [server/http/api.js](server/http/api.js) (`/api/v1`), [server/http/pages.js](server/http/pages.js),
  [server/http/discovery.js](server/http/discovery.js), [server/http/principal.js](server/http/principal.js)
  (person vs service, `X-OV-Subject`, same-origin cookie writes, capabilities),
  [server/http/wallet-cors.js](server/http/wallet-cors.js), [server/http/router.js](server/http/router.js) (async router).
- **Auth:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js),
  [server/auth/scoped-session.js](server/auth/scoped-session.js).
- **Frontend:** server-rendered through [server/render/layout.js](server/render/layout.js),
  [server/render/html.js](server/render/html.js), [server/render/markdown.js](server/render/markdown.js) and
  `openvibe-shared/shell|frame|showcase`; assets [public/css/app.css](public/css/app.css),
  [public/holdings.js](public/holdings.js). Every page works without JavaScript.
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `inventory_kinds`,
  `inventory_definitions`, `inventory_definition_aliases`, `inventory_instances`, `inventory_grants`,
  `inventory_equipped`, `inventory_ledger`, `inventory_store_listings`, `inventory_store_purchases`,
  `inventory_subject_merges`, `event_outbox`, `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-inventory.service](deploy/systemd/openvibe-inventory.service)
  (`/etc/openvibe/inventory.env`, `/opt/inventory.openvibe.network`) and
  [deploy/nginx/inventory.openvibe.network.conf](deploy/nginx/inventory.openvibe.network.conf). `sudo ovhost deploy
  inventory`; database `ov_inventory`; rollback restores the previous sha when `/api/ready` fails.

## Ownership and Boundaries

Inventory is the authority for kinds, definitions, instances, grants, the equipped set and the ledger, plus its
Workshop definitions, store listings/orders and the receipts of account-export/deletion events. It is **not** the
authority for accounts (Network), file bytes (Media), event delivery (Events), money (Billing), or the host/database/
Valkey (Host). Live's old `user_cosmetics`/`user_equipped` are Live's until
[scripts/import-live.js](scripts/import-live.js) has converted them; since ADR-054 Live reads and writes only through
this API. Account deletion removes a person's items and equipped set but keeps ledger rows without the subject, so
supply counts stay true.

## Auth and Capabilities

- Capabilities (Contracts): `inventory.item.read`, `inventory.item.list`, `inventory.equip.manage`,
  `inventory.item.grant`, `inventory.item.consume`, `inventory.definition.manage`, `inventory.definition.review`,
  and `inventory.store.list` (pins Contracts until released).
- A person acts for themself with their Network token or this site's session; a cookie write must be same-origin. A
  service acting for a person sends `X-OV-Subject: usr_…` and holds the route capability. Public reads need no token;
  a presented token must still hold `inventory.item.read`.
- Public reads (`/kinds`, `/definitions`, `/people/:subject/*`, `/equipped`) answer `Access-Control-Allow-Origin: *`
  with no credentials so any site can render what people wear; every other route stays same-site. Do not add a
  credentialed wildcard.
- Outbound: `events.event.publish` + `events.subscription.manage`, `identity.subject.resolve`, and Media
  `media.object.upload` on namespace `inventory`; store purchases use Billing with the person's own bearer.
- Tokens are audience `openvibe.inventory`. Refusals are RFC 9457 problem+json with stable `inventory.*` codes.

## API

`/api/v1`: `GET /ping`, `GET /kinds[/:id]`, `GET /definitions[/:id]`, `GET /people/:subject/items|equipped|holdings|holdings/count`,
`GET /equipped?subjects=a,b,…`, `GET /me/items|holdings|holdings/count`, `PUT /me/equipped`, `POST /grants`,
`POST /instances/:id/consume|revoke`, `POST /definitions`, `PATCH /definitions/:id`,
`GET /store`, `GET /store/purchases/:id`, `POST /store/:id/buy|list|review`.

Holdings: 60 stacks per page (max 200), filters `issuer|site`, `kind`, `rarity`, `equipped`, `tradable`, `text`; sort
`newest|name|rarity|count`; pass `next_cursor` back with the same filters. The cursor pins the newest instance, so
later grants never move a page. `tradable=true` is empty: there is no trade/transfer operation. Events:
`inventory.item.granted|consumed|revoked|equipped|unequipped`, `inventory.definition.published`.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Route handlers via
  [server/http/router.js](server/http/router.js); never leak a raw row or a secret.
- Every browser link goes through [server/urls.js](server/urls.js) so the `openvibe.my/inventory` base path survives
  redirects, discovery and the Markdown twins. API paths never take the prefix.
- New schema = a new `migrations/NNNN_name.sql`; never edit a migration that has run. Keep `inventory_` prefixes.
- CSP: add origins to `helmet` in [server/app.js](server/app.js). Media images come from `openvibe.media`; Billing and
  the wallet's connect-src are already named. Never widen `frameAncestors`/`objectSrc`.
- Phone first: pages must fit 390 px without horizontal scroll; `/me` works with plain forms and no JS.
- Empty states use the shared kit, never bespoke markup; "Calm reduces, only Off removes" applies to any hide
  preference (never delete).
- No Font Awesome; use `openvibe-shared ov-icons` (`KIND_ICON` in [server/http/pages.js](server/http/pages.js)).
- Nothing here sells, buys, trades or converts an item without a reviewed store listing and Billing.

## Key Pitfalls

- **Base path.** The site can be mounted under `/inventory`; a hard-coded `href="/items"` breaks production. Use
  `urls.path()` and `urls.html()`.
- **Store review is mandatory.** A price edit re-enters review; no price may be invented. An order reserves one
  serial under the ordinary grant lock; an uncertain response is recovered by retrying the same item/currency, and
  pending reservations do not expire by themselves.
- **Grants are idempotent per key**; a repeat must not issue a second instance. A capped item answers 409
  `inventory.supply_exhausted`.
- **Public CORS is deliberately credential-free.** `/me` and all writes must stay same-site; wallet-cors is only for
  the named first-party origins in [server/http/wallet-cors.js](server/http/wallet-cors.js).
- **Workshop images** are checked by their own bytes (64–512 px PNG/WebP, ≤200 KB), stored in Media's tenant, and
  never written to the database. On deletion a creator's badges pass to the kind issuer, retired.
- **Drill mode** (`INVENTORY_DRILL`) keeps the outbox relay, subscriptions and timers off; add new background work
  there.
- **Import Live's cosmetics** only with the dry run, `--apply`, then `--verify`; never print Live's URL or secrets.
- **`event_outbox`** needs its rejected partial index ([migrations/0007_outbox_rejected_index.sql](migrations/0007_outbox_rejected_index.sql)).

## Testing

`npm test` runs each file in its own process on a temp PGlite database with mocked Network/Media/Billing:
[test/inventory-api.test.js](test/inventory-api.test.js), [test/holdings.test.js](test/holdings.test.js),
[test/store.test.js](test/store.test.js), [test/workshop.test.js](test/workshop.test.js),
[test/workshop-media-client.test.js](test/workshop-media-client.test.js), [test/public-cors.test.js](test/public-cors.test.js),
[test/base-path.test.js](test/base-path.test.js), [test/import-live.test.js](test/import-live.test.js),
account-data, search-index, SSO, limits, secret-leak/redirect, layout and perf budgets. Run the narrowest file first,
then the suite; `npm run test:pg` for PostgreSQL. Always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, ownership, capabilities, model, API, Workshop, pages, Live migration,
  configuration, acceptance, deploy, security notes.
- [docs/store.md](docs/store.md) — the universal store, review, orders and Billing matching.
- [STATUS.json](STATUS.json) — stage, deployed flag, features and not-yet list.
- [.env.example](.env.example) — variable names only; never commit values.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
