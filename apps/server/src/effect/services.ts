import { Context, Data, Effect, Layer } from 'effect';
import type { PublisherEvent } from '../rpc.js';
import type { Store, StoreOperation, OperationResult } from '../store.js';

/** A safe, declared infrastructure failure for the transport adapter. */
export class PersistenceError extends Data.TaggedError('PersistenceError')<{
  readonly cause: unknown;
}> {}

/** The typed asynchronous persistence boundary. SQLite remains synchronous. */
export interface StoreServiceShape {
  readonly applyOperation: (listId: string, operation: StoreOperation) => Effect.Effect<OperationResult, PersistenceError>;
}

export interface ClockServiceShape {
  readonly now: () => number;
}

export interface PublisherServiceShape {
  readonly publish: (listId: string, event: PublisherEvent) => string;
}

export interface ListSessionServiceShape {
  readonly apply: (listId: string, operation: StoreOperation) => Effect.Effect<OperationResult, PersistenceError>;
}

export const StoreService = Context.GenericTag<StoreServiceShape>('@shoplist/StoreService');
export const ClockService = Context.GenericTag<ClockServiceShape>('@shoplist/ClockService');
export const PublisherService = Context.GenericTag<PublisherServiceShape>('@shoplist/PublisherService');
export const ListSessionService = Context.GenericTag<ListSessionServiceShape>('@shoplist/ListSessionService');

export type ProcessLayer = Layer.Layer<
  StoreServiceShape | ClockServiceShape | PublisherServiceShape | ListSessionServiceShape
>;

/** Process-scoped services used by the first Effect slice. */
export function makeProcessLayer(store: Store, publish: PublisherServiceShape['publish']): ProcessLayer {
  const storeLayer = Layer.succeed(StoreService, {
    // This adapter is deliberately Effect.try rather than a promise wrapper:
    // better-sqlite3 blocks the event loop and the API documents that fact.
    applyOperation: (listId, operation) => Effect.try({
      try: () => store.applyOperation(listId, operation),
      catch: (cause) => new PersistenceError({ cause }),
    }),
  });
  const clockLayer = Layer.succeed(ClockService, { now: () => Date.now() });
  const publisherLayer = Layer.succeed(PublisherService, { publish });
  const sessionLayer = Layer.effect(ListSessionService, Effect.gen(function* () {
    const persistence = yield* StoreService;
    return { apply: persistence.applyOperation };
  }).pipe(Effect.provide(storeLayer)));
  return Layer.mergeAll(storeLayer, clockLayer, publisherLayer, sessionLayer);
}

/** Run one list mutation through the injected application boundary. */
export function runListMutation(
  layer: Layer.Layer<StoreServiceShape | ClockServiceShape | PublisherServiceShape | ListSessionServiceShape>,
  listId: string,
  operation: StoreOperation,
): Promise<OperationResult> {
  return Effect.runPromise(Effect.gen(function* () {
    const service = yield* ListSessionService;
    return yield* service.apply(listId, operation);
  }).pipe(Effect.provide(layer)));
}
