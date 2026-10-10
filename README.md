# OpenVibe.Inventory

> Your items, on every OpenVibe site.

**Status:** alpha (ADR-054, plan track T21 step 2). The authority, its API, pages and Live's migration script are built
and tested; Live switches to it next.
**Domain:** `inventory.openvibe.network` · **Port:** 5030 · **Service id:** `inventory` · **Env prefix:** `INVENTORY`
**License:** AGPL-3.0 (same as every OpenVibe service).

One inventory for an OpenVibe account, the way Steam's works across games. Sites, games and apps give items for what
people do; people keep them in one place and wear them on every site that shows their kind.

## Purpose

OpenVibe.Inventory is the network-wide inventory for an OpenVibe account (ADR-054): one place where the items people
earn or are given across every site, game and app are held. It registers item kinds (a contract plus a renderer per
surface), the definitions an issuer publishes and the instances a person owns, and keeps what each person has equipped.
Every movement is one append-only ledger row and one `inventory.*` event, written in the same transaction as the change.
Nothing is sold, bought, traded or converted into OpenCoins or Vibes (ADR-054 §5).

## Owns

Its own PostgreSQL database (`ov_inventory`) and everything in it: the tables `inventory_kinds`, `inventory_definitions`,
`inventory_definition_aliases`, `inventory_instances`, `inventory_grants`, `inventory_equipped` and `inventory_ledger`
(see [migrations/](migrations/)), plus the SDK's `event_outbox` (events not yet sent) and `account_data_events` (applied
export and deletion receipts). It is the authority for item kinds, definitions, instances, grant receipts, the equipped
set and the ledger. Nothing written there is ever a credential, a key or a token.

## Does not own

- **Identity** is OpenVibe.Network's: it issues the `usr_` subjects, usernames and Network tokens, and resolves an
  `@name` for the Workshop. Inventory stores only the subject.
- **Files** are OpenVibe.Media's: a Workshop badge image is uploaded to this service's Media tenant and referenced by its
  `med_` id; Inventory keeps only the id and the metadata, never the bytes.
- **Event delivery** is OpenVibe.Events': the outbox relay publishes Inventory's events there and the two account
  subscriptions are created there.
- **OpenVibe.Live's own cosmetics tables** (`user_cosmetics`, `user_equipped`) stay Live's; the migration script only
  reads them (ADR-054 §8).

## Depends on

- **OpenVibe.Network** — sign-in (OAuth2 authorization code + PKCE, client `inventory`), the JWKS signing key and
  `GET /internal/identity/resolve` for `@name`: `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`,
  `OV_OAUTH_CLIENT_SECRET`.
- **OpenVibe.Events** — the outbox relay publishes `inventory.*` and the account-export/deletion subscriptions are
  created there: `EVENTS_URL`, `INVENTORY_EVENTS_SECRET`, `EVENTS_RELAY_INTERVAL_MS`.
- **OpenVibe.Media** — Workshop image uploads to this service's tenant: `OV_MEDIA_INTERNAL_URL`,
  `INVENTORY_MEDIA_APP_KEY`.
- **PostgreSQL** (`DATABASE_URL` to serve, `DATABASE_DIRECT_URL` to migrate) and, optionally, **Valkey** for shared
  per-caller limit counters (`VALKEY_URL`).
- **Packages** — `openvibe-contracts` and `openvibe-sdk` (auth, db, events, account-data, limits, service, valkey),
  `openvibe-shared` (shell, frame, legal, seo, serve, showcase, cache-policy, metrics, ready, release), plus Express,
  helmet, ajv, busboy, pg/PGlite and iovalkey.

## Capabilities

Its manifest (openvibe-contracts) registers: `inventory.item.read`, `inventory.item.list`, `inventory.equip.manage`,
`inventory.item.grant`, `inventory.item.consume`, `inventory.definition.manage` and `inventory.definition.review` (the
staff review route).

It calls, on other services: `events.event.publish` and `events.subscription.manage` (OpenVibe.Events; the outbox relay
and the account subscriptions) and `identity.subject.resolve` (OpenVibe.Network; resolving a creator's `@name`).

## The model (ADR-054)

- **Kind** (`live.name_effect`, `live.hat`, …): what its items carry (a JSON Schema), where one is equipped (slots) and
  which surfaces render it (chat, overlays, the profile, `game:<id>`). A new kind is a contract plus a renderer, never a
  new table. Kinds are registered at boot from [server/data/kinds.json](server/data/kinds.json).
- **Definition** (`itd_…`): one item of a kind, with a name, art (a Media image, a renderer token, an emoji), an honest
  rarity (common, uncommon, rare, epic, legendary), attributes valid against the kind, its issuer and an optional
  supply cap. Rarity, attributes and the cap are fixed once it is published.
- **Instance** (`inv_…`): one definition owned by one person, with its origin (granted, earned, migrated), its state
  (owned, consumed, revoked) and, under a cap, a serial number.
- **Equipped:** one instance per kind and slot.
- **Ledger:** an append-only row for every movement, with who did it and why.

Only a kind's issuer defines and grants its items: `service:live` for `live.*`. An issuer may name **grantors** on
one of its items (ADR-054 §3 amendment): other services or apps that may grant that item and nothing more (no edit,
no revoke), recorded in the ledger as the actor. Live names OpenVibe.Quest on six common items, so they are earned as
quest rewards ([server/data/live-grantors.json](server/data/live-grantors.json), applied at boot); their pages say
where to earn them. **Nothing is sold, bought, traded or
converted into OpenCoins or Vibes**, and there are no paid random rewards, until a later ADR covers the legal basis and
Billing (ADR-054 §5). A test fails if a route or a column for that appears.

## API (`/api/v1`, problem+json errors)

The public reads (kinds, definitions, `/people/:subject/*` and `/equipped`) answer every origin with
`Access-Control-Allow-Origin: *` and no credentials, so any site can draw what people wear (openvibe-shared `items.js`);
every other route stays same-site.

| Route | Capability | |
|---|---|---|
| `GET /kinds`, `/kinds/:id` | `inventory.item.read` (public) | the kinds |
| `GET /definitions?kind=&issuer=`, `/definitions/:id` | `inventory.item.read` (public) | published items |
| `GET /people/:subject/items`, `/people/:subject/equipped` | `inventory.item.read` (public) | a person's owned items and what they wear |
| `GET /equipped?subjects=a,b,…` | `inventory.item.read` (public) | up to 100 equipped sets in one call (chat renders) |
| `GET /me/items` | `inventory.item.list` | the caller's own items, every state |
| `PUT /me/equipped` | `inventory.equip.manage` | equip or clear a slot |
| `POST /grants` | `inventory.item.grant` | an issuer grants an instance (idempotent per key; 409 `inventory.supply_exhausted`) |
| `POST /instances/:id/consume`, `/revoke` | `inventory.item.consume` | an issuer uses up or takes back an instance |
| `POST /definitions`, `PATCH /definitions/:id` | `inventory.definition.manage` | an issuer's items |

Tokens are for audience `openvibe.inventory` (Network's rule: `openvibe.<service>`). A person acts for themself (their
token or this site's session; a cookie write must come from this site). A service
acting for a person sends `X-OV-Subject: usr_…` and holds the route's capability. A public read needs no token; a
token that is presented must hold `inventory.item.read`.

**Events** (openvibe-sdk outbox): `inventory.item.granted`, `.consumed`, `.revoked`, `.equipped`, `.unequipped` and
`inventory.definition.published`. **Account export and deletion** (ADR-033) arrive at the loopback
`POST /internal/events` (`INVENTORY_EVENTS_SECRET`; subscriptions created at boot). The export carries the person's
items, equipped set and history. The deletion removes their items and equipped set and keeps the ledger rows without
them, so supply counts stay true.

## The Workshop (ADR-054 §6)

Community badges, free. A signed-in person makes one at `/workshop/new`: a square PNG or WebP image (64 to 512 px, at
most 200 KB, checked by its own bytes and stored in OpenVibe.Media under this service's tenant), a name and a cap of
at most 10 000. They also confirm that they made the image or may use it. It is `in_review`, credited to them and
shown to nobody else until staff publish it at `/workshop/review` (or `POST /api/v1/definitions/:id/review`), with a
rarity, or reject it with a reason the creator reads on `/workshop/mine`. A published badge is given by its creator,
by `@name`, as `granted`, within its cap and 100 gifts a day. People wear it before their name in chat and on their
profile (`network.badge.image@1`; the equipped read carries the image's `media_id`). Limits: 5 in review and 20
submissions a day per person. On account deletion a creator's badges pass to the kind's issuer, retired, without
them.

## Pages

`/` (what it is), `/items` (every item by kind), `/items/:id` (one item: where it shows, who gives it, how many exist),
`/me` (your items; Wear and Take off are plain forms), `/u/:subject` (a person's public inventory) and `/updates`.
Every page works without JavaScript.

## Moving Live's cosmetics (ADR-054 §8)

Live's 70 cosmetics are seeded as definitions issued by `service:live`, with Live's item ids kept as aliases. Then:

```bash
node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env           # dry run
node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env --apply   # convert
node --env-file=/etc/openvibe/inventory.env scripts/import-live.js --live-env /etc/openvibe/live.env --verify  # compare
```

The script only reads Live's database, and never prints its URL. `--apply` keeps unlock times and grants nothing twice.
`--verify` compares every person's items and slots, row for row. Live then reads and writes through this API
(`INVENTORY_AUTHORITY=inventory`), and its tables are dropped after the N-1 window.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `inventory` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. The database is the only required readiness check; the
Network signing key, the OAuth client and Valkey are optional (the service says so, per check, on `/api/ready`).

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network
fnm exec --using=22 npm run dev     # http://localhost:5030
```

Without `DATABASE_URL` development uses an embedded PGlite database in `data/pglite` (one process only). `npm run
test:pg` runs the same suite through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Acceptance

`npm test` runs every [test/*.test.js](test/) in its own process ([test/run.js](test/run.js)) against temp PGlite
databases and an in-process mock Network, so no test needs the network or a running site. `npm run test:pg` runs the same
suite through PostgreSQL and PgBouncer. The main files:

- [test/inventory-api.test.js](test/inventory-api.test.js) — boot seeds Live's five kinds, the Workshop badge and 70
  definitions; a grant is namespaced, idempotent and capped (serials); attributes are validated against the kind;
  equipping is one item per slot; public reads show owned items and the owner's own read every state; consume/revoke;
  a presented token must hold `inventory.item.read`; no buy/sell/trade route or money column exists.
- [test/workshop.test.js](test/workshop.test.js) — a badge is judged by its own bytes (square PNG/WebP, 64–512 px, at
  most 200 KB), submitted in review, published or rejected by staff with a reason, given by `@name`, limited (5 in
  review, 20 submissions and 100 gifts a day), and taken down with or without revoking every copy.
- [test/grantors.test.js](test/grantors.test.js) — Live names Quest on its six reward items; a grantor grants that item
  only (no edit, no revoke), and Live sets and clears the list.
- [test/account-data.test.js](test/account-data.test.js) — account export and deletion over the signed loopback route:
  the ledger rows stay without their subject, supply counts stay true, and a creator's badges pass to the kind, retired.
- [test/import-live.test.js](test/import-live.test.js) — Live's cosmetics move row for row: the dry run, `--apply` (origin
  `migrated`, unlock time kept, idempotent) and `--verify`.
- [test/public-cors.test.js](test/public-cors.test.js) — the public reads answer every origin with `*` and no credentials;
  every other route stays same-site. [test/caller-limits.test.js](test/caller-limits.test.js) — a caller past its limit
  gets 429 problem+json with Retry-After, the declared budgets hold, and health/ready/metrics are never limited.
- [test/auth-ops.test.js](test/auth-ops.test.js), [test/auth-jwks.test.js](test/auth-jwks.test.js) and
  [test/security-session.test.js](test/security-session.test.js) — PKCE sign-in and truthful readiness; the Network JWKS
  fetch, rotation and outage; only a real Network person token is a session.
- [test/security-secrets.test.js](test/security-secrets.test.js), [test/no-internal-key.test.js](test/no-internal-key.test.js)
  and [test/open-redirect.test.js](test/open-redirect.test.js) — the OAuth client secret never leaves in a response, the
  database or a log; no `X-Internal-Key` path; `next=` never leaves the site.
- [test/discovery.test.js](test/discovery.test.js), [test/layout.test.js](test/layout.test.js) and
  [test/asset-cache.test.js](test/asset-cache.test.js) — robots/sitemap/llms and JSON-LD, the server-rendered shell and
  the boost marker, and the asset cache headers.
- [test/nginx-auth-limit.test.js](test/nginx-auth-limit.test.js), [test/service-kit.test.js](test/service-kit.test.js) and
  [test/perf-budget.test.js](test/perf-budget.test.js) — the nginx `/auth/me` zone, the graceful stop order, and the home
  page's size budgets.

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy inventory` on the host (git checkout at `/opt/inventory.openvibe.network`, unit
  `openvibe-inventory.service` on 127.0.0.1:5030, env `/etc/openvibe/inventory.env`, database `ov_inventory` on the data role).
- **nginx:** [deploy/nginx/inventory.openvibe.network.conf](deploy/nginx/inventory.openvibe.network.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- **Network:** OAuth client `inventory`; grants `events.event.publish` and `events.subscription.manage` (openvibe.events),
  then the account grants; the issuers' grants (`live`: `inventory.item.grant`, `inventory.item.consume`,
  `inventory.definition.manage`, `inventory.item.list`, `inventory.equip.manage`, `inventory.item.read`).
- The vhost uses the `openvibe.network` wildcard certificate.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged.
- Nothing in a request may decide a URL this service fetches: a caller's URL goes to OpenVibe.Tools, whose own guard
  decides what may be fetched.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.128.0
- openvibe-sdk: v0.37.2
- openvibe-shared: v3.0.0
- openvibe-publishing: v1.4.0
<!-- versions:end -->
