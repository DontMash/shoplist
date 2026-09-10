# OpenAPI transport at `/api`, native oRPC at `/rpc`

**Status: accepted** (amends ADR-0001)

Shoplist now exposes the same transport contract through two deliberate transports instead of one transport plus temporary compatibility adapters. `/rpc` remains the native oRPC transport: unary procedures over HTTP and list-session procedures over a WebSocket upgrade. `/api` is the OpenAPI transport: the same implemented router served by oRPC's `OpenAPIHandler`, with `listSession.events` streamed as Server-Sent Events. `GET /api/openapi.json` serves the document generated from `@shoplist/transport-contract` with the Zod JSON Schema converter, and `GET /api/docs` serves a Scalar reference that loads that document. The browser client keeps using `/rpc`; `/api` exists for OpenAPI-compatible clients and external tooling.

The legacy `/api/lists`, notification, push-config, and `/api/qr` REST handlers and the custom `/ws` realtime protocol are removed rather than kept as aliases. They duplicated list, notification, and QR behavior outside the shared contract, and the second realtime protocol carried different operation-ID, validation, and terminal-state behavior. Because `/api` is now a breaking route repurposing, deployment must assume stale browser code no longer depends on the removed paths.

The shared `@shoplist/transport-contract` package moved from `apps/` to the root `packages/` workspace so that applications and tooling consume it as an explicit workspace dependency. The package stays transport-only: oRPC contracts, Zod wire schemas, declared errors, event-stream schemas, OpenAPI route metadata, and inferred types. Effect, the Store, the publisher, persistence models, React, and UI schemas stay in their owning applications, so the OpenAPI handler reuses the existing Effect-backed router and dependency graph instead of creating a second one.

Durable list state is unchanged by the second transport. A list revision still fences accepted list state, an Operation ID still identifies a participant mutation across retries, and the publisher cursor and SSE event metadata remain delivery metadata that never replace either. A cancelled SSE response releases the queue and list-session subscription exactly like a closed WebSocket session.

The Scalar documentation route carries its own nonce-based Content-Security-Policy because Scalar needs a CDN bundle, an inline initializer, and inline style attributes. Every other route keeps the application CSP unchanged.
