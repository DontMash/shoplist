# Shoplist

Shared shopping lists with **realtime sync**. Invite the people you shop with via
**link or QR code** — **no accounts required**. Installable as a **PWA**, deployable
with **Docker**.

## Features

- **Realtime sync** — every add, edit, collection and clear is pushed to everyone
  currently viewing the list (WebSocket, full-state sync, auto-reconnect).
- **Invite-only, no accounts** — a list is joined by opening its unguessable
  invite link (`/#/join/<id>`) or scanning its QR code. Whoever has the link can
  view and edit the list; treat the link like a key. Client navigation is handled
  by **wouter** with hash-based URLs so invites and offline app-shell navigation
  remain deployable from any static host.
- **Collected items** — mark an item **Collected** when you have it. Items can
  also be collected with a right swipe; a left swipe deletes an item after
  confirmation.
- **Flexible item ordering** — sort by added time or name, and choose whether
  collected items are grouped at the bottom. Display preferences are per device.
- **Name + amount per item** — both editable inline; the amount is free-form
  (`2`, `500 g`, `1 pack`…).
- **Lists overview at all times** — the home screen shows every list on this
  device with live item counts; create new lists with one tap.
- **Clear list** — removes all items for everyone, behind a **confirm dialog**.
  The list creator additionally gets an owner token that allows **deleting**
  a list permanently.
- **Presence** — see who else is currently in the list (colored initials).
- **List activity notifications** — opt in to privacy-safe browser push alerts for joins and accepted list changes, with per-list mute controls.
- **Swipe gestures** — React item rows support horizontal swipe actions for
  collecting or deleting; vertical movement remains page scroll.
- **Mobile-first PWA** — installable to the home screen (Android/iOS),
  offline app shell via service worker, safe-area aware, dark mode support.
- **QR codes** — rendered server-side as SVG by the `qr.generate` transport
  procedure with the maintained, MIT-licensed `qrcode` package; no client QR
  dependency.

## Quick start (Docker)

```bash
docker compose up -d --build
# → http://localhost:3000
```

Or without compose:

```bash
docker build -t shoplist .
docker run -d -p 3000:3000 -v shoplist-data:/app/data --name shoplist shoplist
```

Open the app, create a list, tap **Invite people**, and share the QR code or
link. Everyone who opens it picks a display name and shops along.

## Manual run (development)

```bash
pnpm install
pnpm dev           # starts the backend and Vite frontend together
```

For local configuration, copy `.env.example` to `.env` at the repository root.
The server also accepts `apps/server/.env`; shell, container, and CI environment
variables take precedence over both files.

To run them in separate terminals:

```bash
pnpm dev:server                         # backend oRPC + OpenAPI API and WebSocket on port 3000
pnpm --filter @shoplist/web dev         # Vite frontend on http://localhost:5173
```

Vite proxies the OpenAPI transport at `/api` and the native oRPC endpoint at
`/rpc` to the backend during development. The server
loads a local `.env` file when present and validates the values with t3-env;
shell, container, and CI environment values retain precedence over that file.
For a production-like local run, build the frontend first and then start the
Node server:

```bash
pnpm build          # typechecks/compiles the server and builds the web app
pnpm start          # serves the Vite build on port 3000
```

| Env var    | Default        | Purpose                          |
| ---------- | -------------- | -------------------------------- |
| `PORT`     | `3000`         | HTTP/WebSocket port              |
| `HOST`     | `0.0.0.0`      | Bind address                     |
| `DATA_DIR` | `./data`       | Directory where `db.sqlite` is stored |
| `PUBLIC_DIR` | built frontend | Directory served for the PWA assets |
| `PUBLIC_ORIGIN` | unset       | Public HTTPS origin used for browser origin checks |
| `VAPID_PUBLIC_KEY` | unset      | Public Web Push application key |
| `VAPID_PRIVATE_KEY` | unset     | Private Web Push application key |
| `VAPID_SUBJECT` | unset       | VAPID contact URI, for example `mailto:admin@example.com` |
| `BUILD_SHA` | `unknown`      | Build identifier exposed by `/healthz` and `X-Shoplist-Build` |

## How it works

- **Server** — a single Node.js process (`apps/server/src/server.ts`) using Hono and
  `@hono/node-server`. It serves the PWA over **two deliberate transports**:
  native oRPC at `/rpc` (unary procedures plus a WebSocket upgrade for
  list-session procedures) and OpenAPI at `/api` (the same implemented router
  as conventional HTTP operations, with `listSession.events` streamed as SSE).
  `/api/openapi.json` serves the document generated from the shared transport
  contract and `/api/docs` serves an interactive Scalar reference backed by
  that document. The QR procedure uses
  [`qrcode`](https://github.com/soldair/node-qrcode)'s async SVG
  renderer so the server returns a compact image without shipping a QR library
  to clients. WebSockets use Hono's `upgradeWebSocket` helper with the same
  Node server (backed by `ws`), so there is no second realtime service.
- **Sync model** — each active route owns a list session. The session keeps an
  authoritative revisioned base plus an optimistic, bounded operation outbox,
  and publishes visible rows through an isolated TanStack DB collection backed
  by the existing TanStack Query cache. Current browsers use typed oRPC
  `listSession.open`, event subscription, and one procedure per mutation
  (`item.add`, `item.update`, `item.delete`, `list.clear`, `list.rename`,
  `list.delete`). The SQLite server applies each operation transactionally,
  persists its original acknowledgement and Operation ID fingerprint, and
  broadcasts revisioned **full list state** events. Reconnects replay the same
  Operation IDs sequentially, so lost acknowledgements cannot duplicate an add
  or repeat a list-wide action. Rejected operations roll back over later pending
  work; edits made while offline remain in memory and are flushed on reconnect.
  Event cursors track delivery only; list revisions remain the reconciliation
  fence.
- **Storage** — a SQLite database (`data/db.sqlite`) accessed through Drizzle ORM
  and the `better-sqlite3` adapter. `store.ts` is the application repository, not
  a second database: it owns the Drizzle connection, validates domain operations,
  maintains the in-memory projection used by WebSocket broadcasts, and handles
  SQLite/legacy-JSON lifecycle and migration. Lists, items, and members have
  separate tables with foreign keys and indexes; each mutation is committed
  transactionally. The first startup automatically imports the former `db.json`
  format and keeps a timestamped `.legacy-*` backup. Back up the SQLite file or
  mount `data` as a volume.
- **Ownership** — the creator of a list receives an `ownerToken` (stored on
  their device only). It is required to delete the list; clearing is open to
  all members (with confirmation).

## Deployment notes

- Put the container behind a reverse proxy with **TLS** for remote use
  (clipboard, share sheet and QR scanning work best in secure contexts;
  `localhost` is exempt). Set `PUBLIC_ORIGIN` to the exact public origin when
  proxy-generated scheme/host headers are not reliable. Otherwise, the proxy
  should preserve the public host and scheme in `X-Forwarded-Host` and
  `X-Forwarded-Proto` (and overwrite client-supplied values); the server uses
  them for same-origin checks after TLS termination. For WebSocket upgrades,
  preserving the public `Host` is required if the proxy omits the forwarded
  scheme. WebSockets pass through any standard proxy — just make sure upgrade
  requests reach the app (default behavior on nginx, Caddy, Traefik,
  Cloudflare).
- `/healthz` reports the configured build identifier and responses include the
  same value in `X-Shoplist-Build`. Set `BUILD_SHA` during image builds so the
  running image can be distinguished from its source branch.
- The app is designed to be served from the **domain root** (`/`).
- To enable list activity push notifications, generate one VAPID key pair and keep
  it stable for the lifetime of the installation:

  ```bash
  pnpm --filter @shoplist/server exec web-push generate-vapid-keys
  ```

  Set the resulting public and private keys as `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT` to a contact URI. Push delivery is
  otherwise unavailable, but realtime list synchronization continues to work.
- To start over, delete the volume / `data/db.sqlite` (and any `.legacy-*` backup).

## Testing

```bash
pnpm build
pnpm start &        # run the server
pnpm test           # Vitest suites + text/HTML coverage reports
pnpm icons          # regenerate PNG icons (TypeScript script)
```

`pnpm test` runs the Vitest suites for the transport contract, server, and web
workspaces. The server suite collects V8 coverage and fails unless lines,
statements, functions, and branches are all at least 90%; reports are written to
`apps/server/coverage/` (ignored generated output).
The root `vitest.config.ts` owns that shared policy; the app configs
only select their required runtime (`node` versus `jsdom`) and frontend setup.

TypeScript options shared by both apps live in the root `tsconfig.json`. Each app
still has a thin config because a Node server needs `NodeNext` while the Vite
frontend needs browser libraries, JSX, and `Bundler` resolution; those settings
cannot be represented safely by one compiling project.

## Project layout

```
apps/server/src/server.ts         Hono app, `/rpc` and `/api` transports, static serving
apps/server/src/rpc.ts             oRPC implementation, event publisher, and session scopes
apps/server/src/openapi.ts         OpenAPI document generated from the shared contract
apps/server/src/effect/services.ts Effect Store/Clock/Publisher/ListSession layers
apps/server/src/store.ts          Drizzle repository/cache + idempotent domain operations
apps/server/src/db/schema.ts       Drizzle SQLite table definitions
packages/transport-contract/src/index.ts Shared oRPC/Zod wire contract and protocol errors
apps/server/tests/smoke.test.ts   Vitest unit, migration, and HTTP seam suite
apps/server/tests/openapi.test.ts OpenAPI, SSE, documentation, and route-removal suite
apps/server/package.json           backend workspace package
apps/server/tsconfig.json          server-specific TypeScript configuration
apps/server/tsconfig.test.json     server + test TypeScript configuration
apps/server/vitest.config.ts       server Vitest environment adapter
apps/web/index.html                Vite entry document
apps/web/src/main.tsx              Typed React app, wouter hash routes, route rendering
apps/web/src/lib/list-session.ts   Revisioned list session, outbox, reconciliation, and TanStack DB bridge
apps/web/src/components/ui/       shadcn-cli generated Base UI components
apps/web/src/lib/list.ts           Typed list helpers and sorting
apps/web/src/lib/utils.ts          Tailwind class-name helper
apps/web/src/app.css               Tailwind theme and app-specific layout styles
apps/web/public/                   Immutable PWA assets (icons)
apps/web/dist/                     Generated Vite production frontend incl. PWA manifest + service worker (after pnpm build)
apps/web/vite.config.ts            Vite dev proxy and production build configuration
apps/web/vitest.config.ts          frontend Vitest environment adapter
apps/web/components.json           shadcn configuration using the Base UI style
apps/web/scripts/gen-icons.ts      TypeScript PNG icon generator
apps/web/package.json              frontend workspace package
apps/web/tsconfig.json             frontend TypeScript configuration
vitest.config.ts                   shared coverage policy and thresholds
tsconfig.json                      shared TypeScript compiler options
pnpm-workspace.yaml                pnpm workspace definition
Dockerfile                         node:24-alpine, unprivileged user, healthcheck
docker-compose.yml                 one service + named volume for data
```
