import { createCollection, type Collection } from '@tanstack/db';
import type { QueryClient } from '@tanstack/react-query';
import { fetchList, listQueryKey, type ListResponse, type ListResponseItem } from './api';
import { uid, type ListItem } from './list';

export type OperationKind =
  | 'item:add'
  | 'item:update'
  | 'item:delete'
  | 'list:clear'
  | 'list:rename'
  | 'list:delete';

export type SessionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'missing'
  | 'deleted'
  | 'closed';

export type RejectionReason =
  | 'name-required'
  | 'invalid-payload'
  | 'item-not-found'
  | 'not-owner'
  | 'list-not-found'
  | 'operation-too-large'
  | 'invalid-operation'
  | 'outbox-full'
  | string;

export interface SessionParticipant {
  clientId: string;
  name: string;
  color: string;
}

export interface AcceptedOperationOutcome {
  kind: 'accepted';
  operationId: string;
  operationKind: OperationKind;
  revision: number;
}

export interface RejectedOperationOutcome {
  kind: 'rejected';
  operationId: string;
  operationKind: OperationKind;
  reason: RejectionReason;
  message?: string;
  revision?: number;
}

export interface TerminalSessionOutcome {
  kind: 'missing' | 'deleted';
  message?: string;
}

export type OperationOutcome = AcceptedOperationOutcome | RejectedOperationOutcome | TerminalSessionOutcome;

export interface ListSessionSnapshot {
  list: { id: string; name: string; createdAt: number } | null;
  items: ListItem[];
  revision: number;
  status: SessionStatus;
  pending: boolean;
  pendingCount: number;
  outcome: OperationOutcome | null;
  online: SessionParticipant[];
}

export interface ItemUpdate {
  name?: string;
  amount?: string;
  collected?: boolean;
}

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

/** Transport seam used by the session. It is deliberately independent of WebSocket. */
export interface ListSessionTransport {
  fetchSnapshot(listId: string, signal?: AbortSignal): Promise<ListResponse>;
  connect(
    options: { listId: string; clientId: string; name: string } & SessionConnectionHandlers,
  ): SessionConnection;
}

export type ListSessionAdapter = ListSessionTransport;

interface BaseState {
  list: { id: string; name: string; createdAt: number };
  items: ListItem[];
  revision: number;
}

interface PendingOperation extends ClientOperation {
  tempItemId?: string;
  state: 'queued' | 'sent' | 'accepted';
  ackRevision?: number;
  serverItem?: ListItem;
  serverItemId?: string;
}

interface AckMessage {
  t: 'ack';
  opId?: string;
  operationId?: string;
  status?: 'accepted' | 'rejected';
  revision?: number;
  reason?: string;
  reasonCode?: string;
  message?: string;
  item?: ListItem;
  itemId?: string;
  tempItemId?: string;
  idMap?: { tempId: string; itemId: string };
}

interface SnapshotMessage {
  t: 'init' | 'state';
  list: { id: string; name: string; createdAt: number; revision?: number; items: ListResponseItem[] };
  online?: SessionParticipant[];
}

const MAX_PENDING = 200;
const STRUCTURAL_KINDS = new Set<OperationKind>(['item:add', 'item:delete', 'list:clear', 'list:rename', 'list:delete']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneItem(item: ListItem): ListItem {
  return { ...item };
}

function normalizeBase(id: string, response: ListResponse): BaseState | null {
  if (response.list.id !== id) return null;
  return {
    list: { id: response.list.id, name: response.list.name, createdAt: response.list.createdAt },
    items: response.items.map((item) => ({ ...item, amount: item.amount || '', collected: Boolean(item.collected) })),
    revision: response.list.revision ?? 0,
  };
}

function initialFromCache(id: string, queryClient?: QueryClient, initial?: ListResponse): BaseState | null {
  const response = initial || queryClient?.getQueryData<ListResponse>(listQueryKey(id));
  return response ? normalizeBase(id, response) : null;
}

/** Browser implementation of the list session transport. */
export const browserListSessionTransport: ListSessionTransport = {
  fetchSnapshot: fetchList,
  connect(options) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${scheme}://${location.host}/ws?list=${encodeURIComponent(options.listId)}` +
      `&client=${encodeURIComponent(options.clientId)}&name=${encodeURIComponent(options.name || 'Guest')}`,
    );
    socket.onopen = options.onOpen;
    socket.onmessage = (event) => {
      try {
        options.onMessage(JSON.parse(String(event.data)));
      } catch {
        // Malformed server data cannot be allowed to break the list session.
      }
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

/**
 * A deterministic adapter for session tests and embedders. No timers or
 * network are hidden inside it: callers explicitly open connections and
 * deliver REST, snapshot, and acknowledgement messages.
 */
export class InMemoryListSessionTransport implements ListSessionTransport {
  public readonly sent: ClientOperation[] = [];
  public readonly connections: Array<InMemorySessionConnection> = [];
  public autoOpen = true;
  public deferBootstrap = false;
  public bootstrapSnapshot: ListResponse;
  public onSend: ((operation: ClientOperation) => void) | null = null;
  private bootstrapWaiters: Array<{ resolve: (value: ListResponse) => void; reject: (error: unknown) => void }> = [];

  public constructor(snapshot?: ListResponse) {
    this.bootstrapSnapshot = snapshot || {
      list: { id: 'list', name: 'Shopping list', createdAt: 0, revision: 0 },
      items: [],
      memberCount: 0,
    };
  }

  public fetchSnapshot(_listId: string, _signal?: AbortSignal): Promise<ListResponse> {
    if (!this.deferBootstrap) return Promise.resolve(this.bootstrapSnapshot);
    return new Promise((resolve, reject) => this.bootstrapWaiters.push({ resolve, reject }));
  }

  public resolveBootstrap(snapshot = this.bootstrapSnapshot): void {
    this.bootstrapSnapshot = snapshot;
    const waiters = this.bootstrapWaiters.splice(0);
    waiters.forEach(({ resolve }) => resolve(snapshot));
  }

  public rejectBootstrap(error: unknown = new Error('offline')): void {
    const waiters = this.bootstrapWaiters.splice(0);
    waiters.forEach(({ reject }) => reject(error));
  }

  public connect(options: { listId: string; clientId: string; name: string } & SessionConnectionHandlers): SessionConnection {
    const connection = new InMemorySessionConnection(options, this);
    this.connections.push(connection);
    if (this.autoOpen) queueMicrotask(() => connection.open());
    return connection;
  }

  public open(): void { this.connections.filter((connection) => !connection.closed).forEach((connection) => connection.open()); }
  public disconnect(code = 1006, reason = 'offline'): void { this.connections.forEach((connection) => connection.closeFromPeer(code, reason)); }
  public deliverSnapshot(snapshot: ListResponse, connection?: InMemorySessionConnection): void {
    const message = { t: 'state', list: { ...snapshot.list, items: snapshot.items } };
    (connection ? [connection] : this.connections).forEach((target) => target.deliver(message));
  }
  public deliverAck(ack: Omit<AckMessage, 't'>, connection?: InMemorySessionConnection): void {
    const message = { t: 'ack', ...ack };
    (connection ? [connection] : this.connections).forEach((target) => target.deliver(message));
  }
  public deliver(message: unknown, connection?: InMemorySessionConnection): void {
    (connection ? [connection] : this.connections).forEach((target) => target.deliver(message));
  }
}

export class InMemorySessionConnection implements SessionConnection {
  public closed = false;
  public openState = false;
  public constructor(
    private readonly options: SessionConnectionHandlers,
    private readonly transport: InMemoryListSessionTransport,
  ) {}
  public open(): void {
    if (this.closed || this.openState) return;
    this.openState = true;
    this.options.onOpen();
  }
  public send(operation: ClientOperation): void {
    if (this.closed || !this.openState) throw new Error('connection is not open');
    this.transport.sent.push({ ...operation, payload: { ...operation.payload } });
    this.transport.onSend?.(operation);
  }
  public deliver(message: unknown): void { if (!this.closed) this.options.onMessage(message); }
  public closeFromPeer(code = 1006, reason = 'offline'): void {
    if (this.closed) return;
    this.closed = true;
    this.openState = false;
    this.options.onClose({ code, reason });
  }
  public close(): void { this.closeFromPeer(1000, 'closed'); }
}

export interface ListSessionOptions {
  listId: string;
  clientId: string;
  name?: string;
  ownerToken?: string | null;
  queryClient?: QueryClient;
  initialSnapshot?: ListResponse;
  transport?: ListSessionTransport;
  autoStart?: boolean;
  maxPending?: number;
  retryDelay?: (attempt: number) => number;
  randomId?: () => string;
}

export interface ListSession {
  readonly listId: string;
  getSnapshot(): ListSessionSnapshot;
  getStatus(): SessionStatus;
  getLatestOutcome(): OperationOutcome | null;
  subscribe(listener: () => void): () => void;
  start(): void;
  close(): void;
  kick(): void;
  addItem(input: { name: string; amount?: string }): string;
  updateItem(itemId: string, patch: ItemUpdate): string | null;
  collectItem(itemId: string, collected?: boolean): string | null;
  deleteItem(itemId: string): string | null;
  clearList(): string | null;
  renameList(name: string): string | null;
  deleteList(ownerToken?: string | null): string | null;
}

/** Create one active, per-list session and its isolated TanStack DB collection. */
export function createListSession(options: ListSessionOptions): ListSession {
  return new ListSessionImpl(options);
}

/** React integration uses this bridge without exposing collection mechanics in the session interface. */
export function getListSessionCollection(session: ListSession): Collection<ListItem> {
  return (session as ListSessionImpl).collection;
}

class ListSessionImpl implements ListSession {
  public readonly listId: string;
  public readonly collection: Collection<ListItem>;
  private readonly clientId: string;
  private readonly name: string;
  private readonly queryClient?: QueryClient;
  private readonly transport: ListSessionTransport;
  private readonly maxPending: number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly randomId: () => string;
  private readonly listeners = new Set<() => void>();
  private readonly initialBase: BaseState | null;
  private base: BaseState | null;
  private pendingOperations: PendingOperation[] = [];
  private online: SessionParticipant[] = [];
  private connection: SessionConnection | null = null;
  private syncVisible: ((items: ListItem[]) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapController = new AbortController();
  private reconnectAttempt = 0;
  private inFlight: string | null = null;
  private started = false;
  private closed = false;
  private terminalState = false;
  private transportOpen = false;
  private outcome: OperationOutcome | null = null;
  private status: SessionStatus = 'connecting';
  private snapshot: ListSessionSnapshot;

  public constructor(options: ListSessionOptions) {
    this.listId = options.listId;
    this.clientId = options.clientId;
    this.name = options.name || 'Guest';
    this.queryClient = options.queryClient;
    this.transport = options.transport || browserListSessionTransport;
    this.maxPending = options.maxPending ?? MAX_PENDING;
    this.retryDelay = options.retryDelay || ((attempt) => Math.min(15000, 700 * 2 ** attempt));
    this.randomId = options.randomId || uid;
    this.initialBase = initialFromCache(this.listId, this.queryClient, options.initialSnapshot);
    this.base = this.initialBase;
    this.snapshot = this.makeSnapshot();

    this.collection = createCollection<ListItem>({
      id: `list-session:${this.listId}:${this.randomId()}`,
      getKey: (item) => item.id,
      startSync: true,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          let published = new Map<string, ListItem>();
          const apply = (items: ListItem[]) => {
            const next = new Map(items.map((item) => [item.id, item] as const));
            begin({ immediate: true });
            for (const key of published.keys()) {
              if (!next.has(key)) write({ type: 'delete', key });
            }
            for (const [key, item] of next) {
              const previous = published.get(key);
              if (!previous) write({ type: 'insert', value: item });
              else if (JSON.stringify(previous) !== JSON.stringify(item)) write({ type: 'update', value: item });
            }
            commit();
            published = new Map([...next].map(([key, item]) => [key, { ...item }]));
          };
          this.syncVisible = apply;
          apply(this.visibleItems());
          markReady();
          return () => { this.syncVisible = null; };
        },
      },
      // The collection is intentionally a state implementation, not the
      // protocol state machine. Session commands update the pending overlay
      // synchronously; server snapshots are published through the sync batch.
      onInsert: async () => undefined,
      onUpdate: async () => undefined,
      onDelete: async () => undefined,
    });
    if (options.autoStart !== false) this.start();
  }

  public getSnapshot(): ListSessionSnapshot { return this.snapshot; }
  public getStatus(): SessionStatus { return this.snapshot.status; }
  public getLatestOutcome(): OperationOutcome | null { return this.snapshot.outcome; }
  public subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  public start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.setStatus(this.base ? 'connecting' : 'connecting');
    void this.bootstrap();
    this.connect();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bootstrapController.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transportOpen = false;
    this.connection?.close();
    this.connection = null;
    this.setStatus('closed');
    void this.collection.cleanup();
  }

  public kick(): void {
    if (this.closed || this.terminalState || this.transportOpen) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  public addItem(input: { name: string; amount?: string }): string {
    const operationId = this.randomId();
    const tempItemId = `temp:${operationId}`;
    this.enqueue({
      operationId,
      kind: 'item:add',
      tempItemId,
      payload: { tempItemId, name: input.name, amount: input.amount || '' },
      state: 'queued',
    });
    this.optimisticInsert({ id: tempItemId, name: input.name, amount: input.amount || '', collected: false, createdAt: Date.now(), updatedAt: Date.now(), by: this.clientId });
    this.reconcile();
    this.pump();
    return tempItemId;
  }

  public updateItem(itemId: string, patch: ItemUpdate): string | null {
    if (!this.visibleItems().some((item) => item.id === itemId)) return null;
    const canonicalId = this.translateId(itemId);
    const latestFence = this.latestStructuralIndex(canonicalId);
    const existing = [...this.pendingOperations].reverse().find((operation, reverseIndex) => {
      const index = this.pendingOperations.length - 1 - reverseIndex;
      return index > latestFence && operation.kind === 'item:update' && operation.state === 'queued' &&
        operation.payload.id === canonicalId;
    });
    if (existing) {
      existing.payload.patch = { ...(isRecord(existing.payload.patch) ? existing.payload.patch : {}), ...patch };
      this.optimisticUpdate(canonicalId, patch);
      this.reconcile();
      this.pump();
      return existing.operationId;
    }
    const operationId = this.randomId();
    this.enqueue({ operationId, kind: 'item:update', payload: { id: canonicalId, patch: { ...patch } }, state: 'queued' });
    this.optimisticUpdate(canonicalId, patch);
    this.reconcile();
    this.pump();
    return operationId;
  }

  public collectItem(itemId: string, collected?: boolean): string | null {
    const item = this.visibleItems().find((candidate) => candidate.id === itemId);
    if (!item) return null;
    return this.updateItem(itemId, { collected: collected ?? !Boolean(item.collected) });
  }

  public deleteItem(itemId: string): string | null {
    if (!this.visibleItems().some((item) => item.id === itemId)) return null;
    const operationId = this.randomId();
    const canonicalId = this.translateId(itemId);
    this.enqueue({ operationId, kind: 'item:delete', payload: { id: canonicalId }, state: 'queued' });
    this.optimisticDelete(canonicalId);
    this.reconcile();
    this.pump();
    return operationId;
  }

  public clearList(): string | null {
    const operationId = this.randomId();
    this.enqueue({ operationId, kind: 'list:clear', payload: {}, state: 'queued' });
    this.optimisticClear();
    this.reconcile();
    this.pump();
    return operationId;
  }

  public renameList(name: string): string | null {
    if (!String(name).trim()) return null;
    const operationId = this.randomId();
    this.enqueue({ operationId, kind: 'list:rename', payload: { name }, state: 'queued' });
    this.reconcile();
    this.pump();
    return operationId;
  }

  public deleteList(ownerToken?: string | null): string | null {
    const operationId = this.randomId();
    this.enqueue({ operationId, kind: 'list:delete', payload: { ownerToken: ownerToken || '' }, state: 'queued' });
    this.reconcile();
    this.pump();
    return operationId;
  }

  private async bootstrap(): Promise<void> {
    try {
      const response = await this.transport.fetchSnapshot(this.listId, this.bootstrapController.signal);
      if (!this.closed && !this.terminalState) this.acceptSnapshot(response);
    } catch {
      if (!this.closed && !this.base) this.setStatus(this.transportOpen ? 'live' : 'reconnecting');
    }
  }

  private connect(): void {
    if (this.closed || this.terminalState || this.transportOpen || this.connection) return;
    try {
      this.connection = this.transport.connect({
        listId: this.listId,
        clientId: this.clientId,
        name: this.name,
        onOpen: () => {
          this.transportOpen = true;
          this.reconnectAttempt = 0;
          this.setStatus('live');
          this.pump();
        },
        onMessage: (message) => this.receive(message),
        onClose: (info) => this.connectionClosed(info),
      });
    } catch {
      this.connectionClosed({ code: 1006, reason: 'connect failed' });
    }
  }

  private connectionClosed(info?: { code?: number; reason?: string }): void {
    this.connection = null;
    this.transportOpen = false;
    if (this.inFlight) {
      const operation = this.pendingOperations.find((candidate) => candidate.operationId === this.inFlight);
      if (operation?.state === 'sent') operation.state = 'queued';
      this.inFlight = null;
    }
    if (this.closed || this.terminalState) return;
    if (info?.code === 4004 || info?.reason === 'list-not-found' || info?.reason === 'missing') {
      this.terminal('missing', 'This list no longer exists.');
      return;
    }
    this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const attempt = this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryDelay(attempt));
  }

  private receive(message: unknown): void {
    if (this.closed || this.terminalState) return;
    if (!isRecord(message) || typeof message.t !== 'string') return;
    if (message.t === 'init' || message.t === 'state') {
      const incoming = message as unknown as SnapshotMessage;
      if (isRecord(incoming.list) && Array.isArray(incoming.list.items)) {
        this.acceptSnapshot({
          list: {
            id: String(incoming.list.id), name: String(incoming.list.name),
            createdAt: Number(incoming.list.createdAt) || 0,
            revision: Number(incoming.list.revision) || 0,
          },
          items: incoming.list.items as ListResponseItem[],
          memberCount: this.queryClient?.getQueryData<ListResponse>(listQueryKey(this.listId))?.memberCount,
        });
      }
      if (message.t === 'init' && Array.isArray(message.online)) this.online = message.online as SessionParticipant[];
      this.refreshSnapshot();
      return;
    }
    if (message.t === 'presence' && Array.isArray(message.online)) {
      this.online = message.online as SessionParticipant[];
      this.refreshSnapshot();
      return;
    }
    if (message.t === 'ack') {
      this.acceptAcknowledgement(message as unknown as AckMessage);
      return;
    }
    if (message.t === 'closed') {
      this.terminal(message.reason === 'deleted' ? 'deleted' : 'missing');
      return;
    }
    if (message.t === 'error') {
      // Legacy servers have no operation identity. Keep the meaningful error
      // visible without attempting to roll back an unknown operation.
      this.outcome = { kind: 'rejected', operationId: '', operationKind: 'list:delete', reason: 'not-owner', message: String(message.message || '') };
      this.refreshSnapshot();
    }
  }

  private acceptSnapshot(response: ListResponse): void {
    const incoming = normalizeBase(this.listId, response);
    if (!incoming) return;
    if (this.terminalState || (this.base && incoming.revision < this.base.revision)) return;
    this.base = incoming;
    this.retireAcknowledged();
    this.reconcile();
    this.updateQueryCache(incoming);
    this.pump();
  }

  private acceptAcknowledgement(message: AckMessage): void {
    const operationId = message.opId || message.operationId;
    if (!operationId) return;
    const index = this.pendingOperations.findIndex((operation) => operation.operationId === operationId);
    if (index === -1) return;
    const operation = this.pendingOperations[index];
    this.inFlight = this.inFlight === operationId ? null : this.inFlight;
    const revision = Number.isFinite(message.revision) ? Number(message.revision) : this.base?.revision || 0;
    if (message.status === 'rejected') {
      this.pendingOperations.splice(index, 1);
      if (operation.kind === 'item:add' && operation.tempItemId) {
        this.pendingOperations = this.pendingOperations.filter((candidate) => candidate.payload.id !== operation.tempItemId);
      }
      this.outcome = {
        kind: 'rejected', operationId, operationKind: operation.kind,
        reason: message.reason || message.reasonCode || 'invalid-operation', message: message.message, revision,
      };
      this.reconcile();
      this.pump();
      return;
    }
    operation.state = 'accepted';
    operation.ackRevision = revision;
    if (message.item) operation.serverItem = cloneItem(message.item);
    if (message.itemId) operation.serverItemId = message.itemId;
    if (message.idMap?.itemId) operation.serverItemId = message.idMap.itemId;
    if (message.tempItemId && operation.tempItemId) operation.tempItemId = message.tempItemId;
    if (message.idMap?.tempId && operation.tempItemId) operation.tempItemId = message.idMap.tempId;
    this.outcome = { kind: 'accepted', operationId, operationKind: operation.kind, revision };
    if (operation.kind === 'list:delete') {
      this.terminal('deleted');
      return;
    }
    this.retireAcknowledged();
    this.reconcile();
    this.pump();
  }

  private retireAcknowledged(): void {
    const revision = this.base?.revision ?? -1;
    const retired = new Set<string>();
    for (const operation of this.pendingOperations) {
      if (operation.state === 'accepted' && operation.ackRevision !== undefined && revision >= operation.ackRevision) {
        retired.add(operation.operationId);
        if (operation.tempItemId && operation.serverItemId) this.translatePendingIds(operation.tempItemId, operation.serverItemId);
      }
    }
    if (retired.size) this.pendingOperations = this.pendingOperations.filter((operation) => !retired.has(operation.operationId));
  }

  private translatePendingIds(from: string, to: string): void {
    for (const operation of this.pendingOperations) {
      if (operation.payload.id === from) operation.payload.id = to;
      if (isRecord(operation.payload.patch) && operation.payload.patch.id === from) operation.payload.patch.id = to;
    }
  }

  private terminal(kind: 'missing' | 'deleted', message?: string): void {
    if (this.terminalState) return;
    this.terminalState = true;
    this.pendingOperations = [];
    this.inFlight = null;
    this.transportOpen = false;
    this.connection?.close();
    this.connection = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.outcome = { kind, message };
    this.setStatus(kind);
  }

  private enqueue(operation: PendingOperation): void {
    this.pendingOperations.push(operation);
    if (this.pendingOperations.length <= this.maxPending) return;
    const dropIndex = this.pendingOperations.findIndex((candidate) => candidate.state === 'queued');
    if (dropIndex === -1) return;
    const [dropped] = this.pendingOperations.splice(dropIndex, 1);
    this.outcome = {
      kind: 'rejected', operationId: dropped.operationId, operationKind: dropped.kind,
      reason: 'outbox-full', message: 'Offline changes are full.',
    };
    this.reconcile();
  }

  private pump(): void {
    if (this.closed || !this.transportOpen || !this.connection || this.inFlight) return;
    const operation = this.pendingOperations.find((candidate) => candidate.state === 'queued');
    if (!operation) return;
    if (this.waitingForIdentity(operation)) return;
    operation.state = 'sent';
    this.inFlight = operation.operationId;
    try {
      this.connection.send(operation);
    } catch {
      operation.state = 'queued';
      this.inFlight = null;
      this.connectionClosed({ code: 1006, reason: 'send failed' });
    }
  }

  private waitingForIdentity(operation: PendingOperation): boolean {
    if ((operation.kind !== 'item:update' && operation.kind !== 'item:delete') || typeof operation.payload.id !== 'string') return false;
    const id = operation.payload.id;
    const add = this.pendingOperations.find((candidate) => candidate.kind === 'item:add' && candidate.tempItemId === id);
    if (!add) return false;
    if (add.state === 'accepted' && add.serverItemId) {
      operation.payload.id = add.serverItemId;
      return false;
    }
    return true;
  }

  private translateId(id: string): string {
    for (const operation of this.pendingOperations) {
      if (operation.kind === 'item:add' && operation.tempItemId === id && operation.serverItemId) return operation.serverItemId;
    }
    return id;
  }

  private latestStructuralIndex(itemId?: string): number {
    let index = -1;
    this.pendingOperations.forEach((operation, operationIndex) => {
      if (!STRUCTURAL_KINDS.has(operation.kind)) return;
      if (operation.kind === 'item:delete' && operation.payload.id !== itemId) return;
      index = operationIndex;
    });
    return index;
  }

  private visibleItems(): ListItem[] {
    const items = new Map<string, ListItem>();
    if (this.base) for (const item of this.base.items) items.set(item.id, cloneItem(item));
    for (const operation of this.pendingOperations) {
      switch (operation.kind) {
        case 'item:add': {
          const item = operation.serverItem || {
            id: operation.serverItemId || operation.tempItemId || String(operation.payload.tempItemId),
            name: String(operation.payload.name || ''), amount: String(operation.payload.amount || ''),
            collected: false, createdAt: Date.now(), updatedAt: Date.now(), by: this.clientId,
          };
          items.set(item.id, cloneItem(item));
          break;
        }
        case 'item:update': {
          const id = String(operation.payload.id || '');
          const resolvedId = this.translateId(id);
          const item = items.get(resolvedId);
          const patch = operation.payload.patch;
          if (item && isRecord(patch)) items.set(resolvedId, { ...item, ...patch });
          break;
        }
        case 'item:delete':
          items.delete(this.translateId(String(operation.payload.id || '')));
          break;
        case 'list:clear':
          items.clear();
          break;
        default:
          break;
      }
    }
    return [...items.values()];
  }

  private visibleListName(): string {
    let name = this.base?.list.name || '';
    for (const operation of this.pendingOperations) if (operation.kind === 'list:rename') name = String(operation.payload.name || name);
    return name;
  }

  private makeSnapshot(): ListSessionSnapshot {
    return {
      list: this.base ? { ...this.base.list, name: this.visibleListName() } : null,
      items: this.visibleItems(),
      revision: this.base?.revision || 0,
      status: this.status,
      pending: this.pendingOperations.length > 0,
      pendingCount: this.pendingOperations.length,
      outcome: this.outcome,
      online: this.online,
    };
  }

  private reconcile(): void {
    const items = this.visibleItems();
    if (this.syncVisible) this.syncVisible(items);
    this.snapshot = this.makeSnapshot();
    this.snapshot.items = items;
    this.notify();
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    this.snapshot = this.makeSnapshot();
    this.notify();
  }

  private updateQueryCache(base: BaseState): void {
    if (!this.queryClient) return;
    const key = listQueryKey(this.listId);
    const previous = this.queryClient.getQueryData<ListResponse>(key);
    if (previous && (previous.list.revision ?? 0) > base.revision) return;
    this.queryClient.setQueryData<ListResponse>(key, {
      list: { ...base.list, revision: base.revision },
      items: base.items.map((item) => ({ ...item, amount: item.amount || '', collected: Boolean(item.collected) })),
      memberCount: previous?.memberCount,
    });
  }

  private optimisticInsert(item: ListItem): void {
    try { this.collection.insert(item); } catch { /* the derived session state remains authoritative */ }
    this.reconcileAfterCollectionMutation();
  }

  private optimisticUpdate(id: string, patch: ItemUpdate): void {
    try {
      if (this.collection.has(id)) this.collection.update(id, (draft) => Object.assign(draft, patch));
    } catch { /* validation is handled by the server acknowledgement */ }
    this.reconcileAfterCollectionMutation();
  }

  private optimisticDelete(id: string): void {
    try { if (this.collection.has(id)) this.collection.delete(id); } catch { /* noop */ }
    this.reconcileAfterCollectionMutation();
  }

  private optimisticClear(): void {
    try {
      const keys = [...this.collection.keys()];
      if (keys.length) this.collection.delete(keys);
    } catch { /* noop */ }
    this.reconcileAfterCollectionMutation();
  }

  private reconcileAfterCollectionMutation(): void {
    // Normal collection mutations provide the immediate optimistic write.
    // Publish the derived snapshot again after their persistence callback so
    // a canonical server row cannot coexist with a temporary local row.
    setTimeout(() => { if (!this.closed) this.reconcile(); }, 0);
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}

/** Factory form is convenient in tests while the class supports manual control. */
export const createInMemoryListSessionTransport = (snapshot?: ListResponse): InMemoryListSessionTransport => (
  new InMemoryListSessionTransport(snapshot)
);
