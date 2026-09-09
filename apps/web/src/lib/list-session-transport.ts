import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { Effect, Fiber } from 'effect';
import { transportContract, PROTOCOL_VERSION, type TransportContract } from '@shoplist/transport-contract';
import { fetchList, type ListResponse } from './api';

export type OperationKind =
  | 'item:add'
  | 'item:update'
  | 'item:delete'
  | 'list:clear'
  | 'list:rename'
  | 'list:delete';

export interface ClientOperation {
  operationId: string;
  kind: OperationKind;
  payload: Record<string, unknown>;
}

export interface SessionConnectionHandlers {
  onOpen: () => void;
  onMessage: (message: unknown) => void;
  onClose: (info?: { code?: number; reason?: string }) => void;
}

export interface SessionConnection {
  send(operation: ClientOperation): void;
  close(): void;
}

export interface SessionConnectionOptions extends SessionConnectionHandlers {
  listId: string;
  clientId: string;
  name: string;
}

/** Transport client generated from the shared contract, not a domain client. */
type TransportClient = ContractRouterClient<TransportContract>;

/** Transport seam used by the list session. It is deliberately independent of WebSocket. */
export interface ListSessionTransport {
  fetchSnapshot(listId: string, signal?: AbortSignal): Promise<ListResponse>;
  connect(options: SessionConnectionOptions): SessionConnection;
}

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/rpc`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorCode(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : '';
}

function rpcEventMessage(event: unknown): unknown {
  const record = asRecord(event);
  if (!record || typeof record.kind !== 'string') return null;
  if (record.kind === 'state') {
    const snapshot = asRecord(record.snapshot);
    const list = asRecord(snapshot?.list);
    if (!snapshot || !list) return null;
    return {
      t: 'state',
      list: { ...list, items: snapshot.items, members: snapshot.members },
      actor: record.actor || null,
      eventCursor: record.eventCursor,
    };
  }
  if (record.kind === 'presence') {
    return { t: 'presence', online: record.online, members: record.members, eventCursor: record.eventCursor };
  }
  if (record.kind === 'list-closed') return { t: 'closed', reason: 'deleted', eventCursor: record.eventCursor };
  if (record.kind === 'upgrade-required') return { t: 'upgrade-required', message: record.message, eventCursor: record.eventCursor };
  return null;
}

function rpcOpenMessage(opened: Awaited<ReturnType<TransportClient['listSession']['open']>>): unknown {
  return {
    t: 'init',
    protocolVersion: opened.protocolVersion,
    sessionId: opened.sessionId,
    you: opened.you,
    list: { ...opened.snapshot.list, items: opened.snapshot.items, members: opened.snapshot.members },
    online: opened.online,
    eventCursor: opened.eventCursor,
  };
}

function rpcAckMessage(ack: Awaited<ReturnType<TransportClient['item']['add']>>): unknown {
  return {
    t: 'ack',
    protocolVersion: ack.protocolVersion,
    opId: ack.operationId,
    status: ack.status,
    revision: ack.revision,
    ...(ack.reason ? { reason: ack.reason, reasonCode: ack.reason } : {}),
    ...(ack.message ? { message: ack.message } : {}),
    ...(ack.item ? { item: ack.item } : {}),
    ...(ack.itemId ? { itemId: ack.itemId } : {}),
    ...(ack.tempItemId ? { tempItemId: ack.tempItemId } : {}),
    ...(ack.idMap ? { idMap: ack.idMap } : {}),
  };
}

/** Browser oRPC implementation. It owns one socket and no retry loop. */
function connectRpc(options: SessionConnectionOptions, socket: WebSocket): SessionConnection {
  const client = createORPCClient<TransportClient>(new RPCLink({ websocket: socket }));
  let sessionId: string | null = null;
  let eventCursor: string | undefined;
  let closed = false;
  let eventFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
  const commandControllers = new Set<AbortController>();

  const onRpcFailure = (error: unknown): void => {
    if (closed) return;
    const code = errorCode(error);
    closed = true;
    if (code === 'UPGRADE_REQUIRED') {
      options.onMessage({ t: 'upgrade-required', message: 'Reload to use the current list-session protocol.' });
      options.onClose({ code: 4006, reason: 'upgrade-required' });
    } else if (code === 'NOT_FOUND') {
      options.onClose({ code: 4004, reason: 'list-not-found' });
    } else {
      options.onClose({ code: 1006, reason: 'rpc request failed' });
    }
    for (const controller of commandControllers) controller.abort();
    commandControllers.clear();
    try { socket.close(); } catch { /* noop */ }
  };

  const consume = async (events: Awaited<ReturnType<TransportClient['listSession']['events']>>): Promise<void> => {
    if (!sessionId || closed) return;
    // Establish the event subscription before exposing the connection as live;
    // otherwise a fast item.add could commit before its state event has a
    // subscriber.
    for await (const event of events) {
      if (closed) return;
      const message = rpcEventMessage(event);
      if (message) options.onMessage(message);
    }
  };

  const open = Effect.tryPromise({
    try: () => client.listSession.open({
      listId: options.listId,
      clientId: options.clientId,
      name: options.name || 'Guest',
      protocolVersion: PROTOCOL_VERSION,
    }),
    catch: (error) => error,
  });

  void Effect.runPromise(open).then((opened) => {
    if (closed) return;
    sessionId = opened.sessionId;
    eventCursor = opened.eventCursor;
    const stream = Effect.tryPromise({
      try: async () => {
        const events = await client.listSession.events({ listId: options.listId, sessionId: opened.sessionId, cursor: opened.eventCursor });
        if (closed) return;
        options.onMessage(rpcOpenMessage(opened));
        options.onOpen();
        await consume(events);
      },
      catch: (error) => error,
    });
    eventFiber = Effect.runFork(stream.pipe(Effect.catchAll((error) => Effect.sync(() => onRpcFailure(error)))));
  }).catch(onRpcFailure);

  const send = (operation: ClientOperation): void => {
    if (closed || !sessionId || socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open');
    const common = {
      listId: options.listId,
      sessionId,
      clientId: options.clientId,
      operationId: operation.operationId,
    };
    const controller = new AbortController();
    commandControllers.add(controller);
    const requestOptions = { signal: controller.signal };
    let request: Promise<unknown>;
    switch (operation.kind) {
      case 'item:add':
        request = client.item.add({ ...common, name: String(operation.payload.name || ''), amount: String(operation.payload.amount || ''), tempItemId: typeof operation.payload.tempItemId === 'string' ? operation.payload.tempItemId : undefined }, requestOptions);
        break;
      case 'item:update':
        request = client.item.update({ ...common, id: String(operation.payload.id || ''), patch: (operation.payload.patch || {}) as { name?: string; amount?: string; collected?: boolean } }, requestOptions);
        break;
      case 'item:delete':
        request = client.item.delete({ ...common, id: String(operation.payload.id || '') }, requestOptions);
        break;
      case 'list:clear':
        request = client.list.clear(common, requestOptions);
        break;
      case 'list:rename':
        request = client.list.rename({ ...common, name: String(operation.payload.name || '') }, requestOptions);
        break;
      case 'list:delete':
        request = client.list.delete({ ...common, ownerToken: String(operation.payload.ownerToken || '') }, requestOptions);
        break;
    }
    const completion = Effect.tryPromise({ try: () => request, catch: (error) => error });
    void Effect.runPromise(completion)
      .then((ack) => options.onMessage(rpcAckMessage(ack as Awaited<ReturnType<TransportClient['item']['add']>>)))
      .catch(onRpcFailure)
      .finally(() => commandControllers.delete(controller));
  };

  socket.addEventListener('close', (event) => {
    if (closed) return;
    closed = true;
    options.onClose({ code: event.code, reason: event.reason });
  });
  socket.addEventListener('error', () => {
    if (!closed) socket.close();
  });

  return {
    send,
    close() {
      if (closed) return;
      closed = true;
      if (eventFiber) void Effect.runFork(Fiber.interrupt(eventFiber));
      for (const controller of commandControllers) controller.abort();
      commandControllers.clear();
      try { socket.close(); } catch { /* noop */ }
    },
  };
}

/** Compatibility adapter used only by the old fake socket in legacy tests. */
function connectLegacy(options: SessionConnectionOptions, socket: WebSocket): SessionConnection {
  socket.onopen = options.onOpen;
  socket.onmessage = (event) => {
    try { options.onMessage(JSON.parse(String(event.data))); } catch { /* malformed data is ignored */ }
  };
  socket.onclose = (event) => options.onClose({ code: event.code, reason: event.reason });
  socket.onerror = () => {
    try { socket.close(); } catch { /* noop */ }
  };
  return {
    send(operation) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open');
      socket.send(JSON.stringify(toWireOperation(operation)));
    },
    close() {
      try { socket.close(); } catch { /* noop */ }
    },
  };
}

/** Browser implementation of the list session transport. */
export const browserListSessionTransport: ListSessionTransport = {
  fetchSnapshot: fetchList,
  connect(options) {
    const socket = new WebSocket(socketUrl());
    // The fallback is intentionally limited to test doubles/legacy embedded
    // clients. Native browser WebSockets use the typed oRPC route above.
    if (typeof (socket as unknown as { addEventListener?: unknown }).addEventListener !== 'function') {
      return connectLegacy(options, socket);
    }
    return connectRpc(options, socket);
  },
};

function toWireOperation(operation: ClientOperation): Record<string, unknown> {
  const { operationId: opId, kind, payload } = operation;
  switch (kind) {
    case 'item:add':
      return { t: kind, opId, tempId: payload.tempItemId, item: { name: payload.name, amount: payload.amount } };
    case 'item:update':
      return { t: kind, opId, id: payload.id, patch: payload.patch };
    case 'item:delete':
      return { t: kind, opId, id: payload.id };
    case 'list:rename':
      return { t: kind, opId, name: payload.name };
    case 'list:delete':
      return { t: kind, opId, ownerToken: payload.ownerToken };
    case 'list:clear':
      return { t: kind, opId };
  }
}
