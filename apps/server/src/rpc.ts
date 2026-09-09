import { ORPCError } from '@orpc/client';
import { Layer } from 'effect';
import { implement } from '@orpc/server';
import type { NotificationDispatcher } from './notifications.js';
import { colorFor } from './rpc-support.js';
import {
  PROTOCOL_VERSION,
  transportContract,
  type Item,
  type ListSessionOpenOutput,
  type Participant,
  type SessionEvent,
} from '@shoplist/transport-contract';
import { cleanText, rid, type Store, type StoreOperation, type OperationKind, type ShoppingItem, type ShoppingList } from './store.js';
import {
  makeProcessLayer,
  runListMutation,
  type PublisherServiceShape,
} from './effect/services.js';

type WithoutCursor<T> = T extends unknown ? Omit<T, 'eventCursor'> : never;
export type PublisherEvent = WithoutCursor<SessionEvent>;

type QueueResult = IteratorResult<SessionEvent>;

type RpcContext = {
  readonly store: Store;
  readonly publisher: RpcEventPublisher;
  readonly sessions: RpcSessionRegistry;
  readonly dispatcher: NotificationDispatcher;
  readonly publicKey: string;
  readonly effectLayer: Layer.Layer<any, never, never>;
};

interface RpcSession {
  readonly sessionId: string;
  readonly listId: string;
  readonly clientId: string;
  readonly name: string;
  readonly participant: Participant;
}

/** A small cancellable async queue used as the oRPC event-iterator source. */
class EventQueue implements AsyncIterator<SessionEvent>, AsyncIterable<SessionEvent> {
  private readonly pending: Array<(result: QueueResult) => void> = [];
  private readonly values: SessionEvent[] = [];
  private ended = false;

  public push(value: SessionEvent): void {
    if (this.ended) return;
    const resolve = this.pending.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  public end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.pending.length) this.pending.shift()!({ done: true, value: undefined });
  }

  public next(): Promise<QueueResult> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.pending.push(resolve));
  }

  public return(): Promise<QueueResult> {
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<SessionEvent> { return this; }
}

/** Process-local event publisher. Cursors are delivery cursors, not revisions. */
export class RpcEventPublisher {
  private readonly cursors = new Map<string, number>();
  private readonly history = new Map<string, SessionEvent[]>();
  private readonly subscribers = new Map<string, Set<EventQueue>>();

  public cursor(listId: string): string {
    return String(this.cursors.get(listId) || 0);
  }

  public subscribe(listId: string, cursor?: string): EventQueue {
    const queue = new EventQueue();
    const subscribers = this.subscribers.get(listId) || new Set<EventQueue>();
    subscribers.add(queue);
    this.subscribers.set(listId, subscribers);
    const after = cursor === undefined ? Number.NaN : Number(cursor);
    if (Number.isInteger(after)) {
      for (const event of this.history.get(listId) || []) {
        if (Number(event.eventCursor) > after) queue.push(event);
      }
    }
    return queue;
  }

  public unsubscribe(listId: string, queue: EventQueue): void {
    const subscribers = this.subscribers.get(listId);
    if (!subscribers) return;
    subscribers.delete(queue);
    if (subscribers.size === 0) this.subscribers.delete(listId);
  }

  public publish(listId: string, event: PublisherEvent): string {
    const cursor = String((this.cursors.get(listId) || 0) + 1);
    this.cursors.set(listId, Number(cursor));
    const withCursor = { ...event, eventCursor: cursor } as SessionEvent;
    const events = this.history.get(listId) || [];
    events.push(withCursor);
    if (events.length > 100) events.splice(0, events.length - 100);
    this.history.set(listId, events);
    for (const queue of this.subscribers.get(listId) || []) queue.push(withCursor);
    return cursor;
  }

  public close(listId: string): void {
    for (const queue of this.subscribers.get(listId) || []) queue.end();
    this.subscribers.delete(listId);
  }

  public closeAll(): void {
    for (const listId of this.subscribers.keys()) this.close(listId);
    this.history.clear();
    this.cursors.clear();
  }
}

export class RpcSessionRegistry {
  private readonly sessions = new Map<string, RpcSession>();

  public open(listId: string, clientId: string, name: string): RpcSession {
    const normalizedClientId = cleanText(clientId, 64);
    const normalizedName = cleanText(name, 40) || 'Guest';
    const participant: Participant = { clientId: normalizedClientId, name: normalizedName, color: colorFor(normalizedClientId) };
    const session = {
      sessionId: `session-${cryptoRandomId()}`,
      listId,
      clientId: normalizedClientId,
      name: participant.name,
      participant,
    } satisfies RpcSession;
    this.sessions.set(session.sessionId, session);
    return session;
  }

  public get(sessionId: string): RpcSession | undefined { return this.sessions.get(sessionId); }

  public close(sessionId: string): RpcSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.delete(sessionId);
    return session;
  }

  public closeList(listId: string): RpcSession[] {
    const closed: RpcSession[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.listId !== listId) continue;
      this.sessions.delete(sessionId);
      closed.push(session);
    }
    return closed;
  }

  public closeAll(): void {
    this.sessions.clear();
  }

  public online(listId: string): Participant[] {
    const seen = new Set<string>();
    const result: Participant[] = [];
    for (const session of this.sessions.values()) {
      if (session.listId !== listId || seen.has(session.clientId)) continue;
      seen.add(session.clientId);
      result.push(session.participant);
    }
    return result;
  }

  public onlineClientIds(listId: string): Set<string> {
    return new Set(this.online(listId).map((participant) => participant.clientId));
  }
}

function cryptoRandomId(): string {
  // `crypto.randomUUID` is not available in every browser test runtime, while
  // the server always has a cryptographic random source through the Store IDs.
  return rid(9);
}

function invalid(code: string, message: string, status = 400): never {
  throw new ORPCError(code, {
    status,
    message,
    data: { code, message, retryable: false },
  });
}

function listOrThrow(store: Store, listId: string): ShoppingList {
  const list = store.getList(listId);
  if (!list) invalid('NOT_FOUND', 'The list no longer exists.', 404);
  return list;
}

function participantList(list: ShoppingList): Participant[] {
  return Object.values(list.members).map((member) => ({
    clientId: member.clientId,
    name: member.name,
    color: member.color,
  }));
}

function publicItem(item: ShoppingItem): Item {
  return {
    id: item.id,
    name: item.name,
    amount: item.amount,
    collected: item.collected,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    by: item.by,
    lastEditedBy: item.lastEditedBy,
  };
}

function snapshot(store: Store, listId: string) {
  const list = listOrThrow(store, listId);
  const members = participantList(list);
  return {
    list: {
      id: list.id,
      name: list.name,
      createdAt: list.createdAt,
      revision: list.revision,
    },
    items: list.items.map(publicItem),
    members,
    memberCount: store.memberCount(list),
  };
}

function toAck(result: ReturnType<Store['applyOperation']>) {
  const ack = result.ack;
  return {
    protocolVersion: PROTOCOL_VERSION,
    operationId: ack.opId,
    status: ack.status,
    revision: ack.revision,
    ...(ack.reason ? { reason: ack.reason } : {}),
    ...(ack.message ? { message: ack.message } : {}),
    ...(ack.item ? { item: publicItem(ack.item) } : {}),
    ...(ack.itemId ? { itemId: ack.itemId } : {}),
    ...(ack.tempItemId ? { tempItemId: ack.tempItemId } : {}),
    ...(ack.idMap ? { idMap: ack.idMap } : {}),
  };
}

function assertSession(context: RpcContext, listId: string, sessionId: string, clientId?: string): RpcSession {
  const session = context.sessions.get(sessionId);
  if (!session || session.listId !== listId || (clientId !== undefined && session.clientId !== clientId)) {
    invalid('FORBIDDEN', 'The list session is not active.', 403);
  }
  return session;
}

export function publishPresence(context: RpcContext, listId: string): void {
  const list = context.store.getList(listId);
  if (!list) return;
  context.publisher.publish(listId, {
    kind: 'presence',
    protocolVersion: PROTOCOL_VERSION,
    online: context.sessions.online(listId),
    members: participantList(list),
  });
}

function publishMutation(context: RpcContext, listId: string, result: ReturnType<Store['applyOperation']>, actor: Participant): void {
  if (result.terminal) {
    context.publisher.publish(listId, {
      kind: 'list-closed',
      protocolVersion: PROTOCOL_VERSION,
      reason: 'deleted',
    });
    context.publisher.close(listId);
    context.sessions.closeList(listId);
    return;
  }
  if (result.ack.status !== 'accepted' || !result.list) return;
  context.publisher.publish(listId, {
    kind: 'state',
    protocolVersion: PROTOCOL_VERSION,
    snapshot: snapshot(context.store, listId),
    actor,
  });
}

async function applyMutation(
  context: RpcContext,
  input: { listId: string; sessionId: string; clientId: string; operationId: string },
  kind: OperationKind,
  payload: Record<string, unknown>,
) {
  const session = assertSession(context, input.listId, input.sessionId, input.clientId);
  const operation: StoreOperation = {
    operationId: input.operationId,
    kind,
    payload,
    actorClientId: session.clientId,
    actorName: session.name,
    protocolVersion: PROTOCOL_VERSION,
  };
  let result: ReturnType<Store['applyOperation']>;
  try {
    result = await runListMutation(context.effectLayer, input.listId, operation);
  } catch {
    console.error('[rpc] persistence failure');
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'The list is temporarily unavailable.',
      data: { code: 'INTERNAL_SERVER_ERROR', message: 'The list is temporarily unavailable.', retryable: true },
    });
  }
  const ack = toAck(result);
  if (!result.duplicate && result.notification) {
    void context.dispatcher.dispatch(result.notification, result.notificationRecipients);
  }
  if (!result.duplicate) publishMutation(context, input.listId, result, session.participant);
  return ack;
}

/** Build the server implementation while keeping the shared package contract-only. */
export interface RpcDependencies {
  readonly store: Store;
  readonly publisher: RpcEventPublisher;
  readonly sessions: RpcSessionRegistry;
  readonly dispatcher: NotificationDispatcher;
  readonly publicKey: string;
}

export function createRpcRouter(deps: RpcDependencies) {
  const effectLayer = makeProcessLayer(deps.store, (listId, event) => deps.publisher.publish(listId, event));
  const context = { ...deps, effectLayer } satisfies RpcContext;
  // Dependencies are captured once in process-scoped layers. The oRPC
  // request context intentionally remains empty so transport adapters cannot
  // become a second dependency-injection system.
  const implementer = implement(transportContract);

  return implementer.router({
    list: {
      get: implementer.list.get.handler(({ input }) => {
        const list = listOrThrow(context.store, input.id);
        return {
          ...snapshot(context.store, list.id),
          list: { id: list.id, name: list.name, createdAt: list.createdAt, revision: list.revision },
        };
      }),
      create: implementer.list.create.handler(({ input }) => {
        const list = context.store.createList(input.name);
        return {
          list: { id: list.id, name: list.name, createdAt: list.createdAt, revision: list.revision },
          ownerToken: list.ownerToken,
        };
      }),
      leave: implementer.list.leave.handler(({ input }) => ({ left: context.store.leaveMember(input.listId, input.clientId) })),
      clear: implementer.list.clear.handler(({ input }) => applyMutation(context, input, 'list:clear', {})),
      rename: implementer.list.rename.handler(({ input }) => applyMutation(context, input, 'list:rename', { name: input.name })),
      delete: implementer.list.delete.handler(({ input }) => applyMutation(context, input, 'list:delete', { ownerToken: input.ownerToken })),
    },
    push: {
      config: implementer.push.config.handler(() => ({ publicKey: deps.publicKey || null, available: Boolean(deps.publicKey) })),
      status: implementer.push.status.handler(({ input }) => {
        listOrThrow(context.store, input.listId);
        return { ...context.store.getNotificationStatus(input.listId, input.clientId), available: Boolean(deps.publicKey) };
      }),
      register: implementer.push.register.handler(({ input }) => {
        listOrThrow(context.store, input.listId);
        if (!context.store.registerPushDestination(input.listId, input.clientId, input.subscription)) {
          invalid('FORBIDDEN', 'The participant is not active.', 403);
        }
        return { ...context.store.getNotificationStatus(input.listId, input.clientId), available: Boolean(deps.publicKey) };
      }),
      mute: implementer.push.mute.handler(({ input }) => {
        listOrThrow(context.store, input.listId);
        if (!context.store.setNotificationsMuted(input.listId, input.clientId, input.muted)) {
          invalid('NOT_FOUND', 'Notifications are not enabled.', 404);
        }
        return { ...context.store.getNotificationStatus(input.listId, input.clientId), available: Boolean(deps.publicKey) };
      }),
      remove: implementer.push.remove.handler(({ input }) => {
        listOrThrow(context.store, input.listId);
        context.store.disableNotifications(input.listId, input.clientId);
        return { ...context.store.getNotificationStatus(input.listId, input.clientId), available: Boolean(deps.publicKey) };
      }),
    },
    qr: {
      generate: implementer.qr.generate.handler(async ({ input }) => {
        const QRCode = await import('qrcode');
        try {
          return { svg: await QRCode.default.toString(input.data, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256 }) };
        } catch {
          invalid('BAD_REQUEST', 'Could not encode data.', 400);
        }
      }),
    },
    listSession: {
      open: implementer.listSession.open.handler(({ input }) => {
        if (input.protocolVersion !== PROTOCOL_VERSION) {
          throw new ORPCError('UPGRADE_REQUIRED', {
            status: 426,
            message: 'Reload to use the current list-session protocol.',
            data: { code: 'UPGRADE_REQUIRED', message: 'Reload to use the current list-session protocol.', retryable: false },
          });
        }
        const list = listOrThrow(context.store, input.listId);
        const clientId = cleanText(input.clientId, 64);
        if (!clientId) invalid('BAD_REQUEST', 'A participant identity is required.', 400);
        const session = context.sessions.open(list.id, clientId, input.name || 'Guest');
        context.store.touchMember(list, session.clientId, session.name, session.participant.color);
        publishPresence(context, list.id);
        return {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: session.sessionId,
          you: session.participant,
          snapshot: snapshot(context.store, list.id),
          online: context.sessions.online(list.id),
          eventCursor: context.publisher.cursor(list.id),
        } satisfies ListSessionOpenOutput;
      }),
      events: implementer.listSession.events.handler(async function* ({ input }) {
        const session = assertSession(context, input.listId, input.sessionId);
        const queue = context.publisher.subscribe(session.listId, input.cursor);
        try {
          for await (const event of queue) yield event;
        } finally {
          context.publisher.unsubscribe(session.listId, queue);
          const closed = context.sessions.close(session.sessionId);
          if (closed) publishPresence(context, session.listId);
        }
      }),
    },
    item: {
      add: implementer.item.add.handler(({ input }) => applyMutation(context, input, 'item:add', {
        name: input.name,
        amount: input.amount || '',
        ...(input.tempItemId ? { tempItemId: input.tempItemId } : {}),
      })),
      update: implementer.item.update.handler(({ input }) => applyMutation(context, input, 'item:update', { id: input.id, patch: input.patch })),
      delete: implementer.item.delete.handler(({ input }) => applyMutation(context, input, 'item:delete', { id: input.id }))
    },
  });
}

export type RpcRouter = ReturnType<typeof createRpcRouter>;
