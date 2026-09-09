# oRPC transport and Effect workflow boundaries

**Status: accepted**

Shoplist uses one `/rpc` endpoint for typed oRPC procedures: unary procedures use the fetch handler and list-session procedures use the oRPC WebSocket handler. The shared `@shoplist/transport-contract` package contains only Zod wire schemas, oRPC contracts, protocol errors, and inferred transport types; domain, persistence, UI, and Effect services remain in their owning applications.

The list-session event cursor is delivery metadata only. Durable list revisions continue to fence full-state reconciliation, and Operation IDs continue to identify participant-requested mutations across retries. Full-state events are retained for the first migration because they preserve the existing recovery behavior without introducing a durable event log. Effect is introduced behind the server application-service boundary and the browser transport/session seam; its Store service explicitly wraps synchronous `better-sqlite3` work rather than implying non-blocking persistence. Store, clock, and publisher resources are process-scoped, while each event iterator owns a cancellable list-session scope. A future persistence worker or delta event protocol can be introduced independently without changing the transport contract.

During rollout, the existing `/api` and `/ws` handlers remain as compatibility adapters for already-open or embedded clients; new browser connections use the `/rpc` contract and protocol-version mismatch is terminal with an upgrade-required outcome. These adapters are not additional application implementations and can be removed after the deployment window for legacy clients closes.
