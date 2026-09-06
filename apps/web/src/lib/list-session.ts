import { createCollection, type Collection, type NonSingleResult } from '@tanstack/db';
import type { QueryClient } from '@tanstack/react-query';
import { leaveList, listQueryKey, type ListResponse, type ListResponseItem } from './api';
import { uid, type ListItem, type ListParticipant } from './list';
import {
  browserListSessionTransport,
  type ClientOperation,
  type ListSessionTransport,
  type OperationKind,
  type SessionConnection,
} from './list-session-transport';

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

export type SessionParticipant = ListParticipant;

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
  members: SessionParticipant[];
}

export interface ItemUpdate {
  name?: string;
  amount?: string;
  collected?: boolean;
}

interface BaseState {
  list: { id: string; name: string; createdAt: number };
  items: ListItem[];
  revision: number;
  members: SessionParticipant[];
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
  list: { id: string; name: string; createdAt: number; revision?: number; items: ListResponseItem[]; members?: SessionParticipant[] };
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeOnline(value: unknown): SessionParticipant[] | null {
  if (!Array.isArray(value)) return null;
  const participants = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.clientId !== 'string' || !entry.clientId ||
      typeof entry.name !== 'string' || typeof entry.color !== 'string') return null;
    return { clientId: entry.clientId, name: entry.name, color: entry.color };
  });
  return participants.some((participant) => participant === null) ? null : participants as SessionParticipant[];
}

function normalizeItem(value: unknown): ListItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) {
    return null;
  }
  if (value.amount !== undefined && typeof value.amount !== 'string') return null;
  if (value.collected !== undefined && typeof value.collected !== 'boolean') return null;
  if (value.createdAt !== undefined && (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt))) return null;
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt))) return null;
  if (value.by !== undefined && value.by !== null && typeof value.by !== 'string') return null;
  if (value.lastEditedBy !== undefined && value.lastEditedBy !== null && typeof value.lastEditedBy !== 'string') return null;
  const amount = value.amount as string | undefined;
  const collected = value.collected as boolean | undefined;
  return {
    id: value.id,
    name: value.name,
    amount: amount === undefined ? '' : amount,
    collected: collected === undefined ? false : collected,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt as number }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as number }),
    ...(value.by === undefined ? {} : { by: value.by as string | null }),
    ...(value.lastEditedBy === undefined ? {} : { lastEditedBy: value.lastEditedBy as string | null }),
  };
}

function normalizeMembers(value: unknown): SessionParticipant[] | null {
  if (value === undefined) return [];
  return normalizeOnline(value);
}

function normalizeBase(id: string, response: unknown): BaseState | null {
  if (!isRecord(response) || !isRecord(response.list) || !Array.isArray(response.items)) return null;
  const list = response.list;
  if (list.id !== id || typeof list.name !== 'string' || typeof list.createdAt !== 'number' || !Number.isFinite(list.createdAt)) {
    return null;
  }
  const revision = list.revision === undefined ? 0 : list.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  const items = response.items.map(normalizeItem);
  const members = normalizeMembers(response.members);
  if (items.some((item) => item === null) || members === null) return null;
  return {
    list: { id: list.id, name: list.name, createdAt: list.createdAt },
    items: items as ListItem[],
    revision,
    members,
  };
}

function initialFromCache(id: string, queryClient?: QueryClient, initial?: ListResponse): BaseState | null {
  const response = initial || queryClient?.getQueryData<ListResponse>(listQueryKey(id));
  return response ? normalizeBase(id, response) : null;
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
  leave(): Promise<boolean>;
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
export function getListSessionCollection(session: ListSession): Collection<ListItem> & NonSingleResult {
  return (session as ListSessionImpl).collection as Collection<ListItem> & NonSingleResult;
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

  public readonly getSnapshot = (): ListSessionSnapshot => this.snapshot;
  public readonly getStatus = (): SessionStatus => this.snapshot.status;
  public readonly getLatestOutcome = (): OperationOutcome | null => this.snapshot.outcome;
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

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

  public async leave(): Promise<boolean> {
    if (this.closed) return false;
    const left = await leaveList(this.listId, this.clientId);
    this.close();
    return left;
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
    this.optimisticInsert({ id: tempItemId, name: input.name, amount: input.amount || '', collected: false, createdAt: Date.now(), updatedAt: Date.now(), by: this.clientId, lastEditedBy: this.clientId });
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
    if (this.visibleItems().length === 0) return null;
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
          list: incoming.list as SnapshotMessage['list'],
          items: incoming.list.items as ListResponseItem[],
          members: incoming.list.members,
          memberCount: this.queryClient?.getQueryData<ListResponse>(listQueryKey(this.listId))?.memberCount,
        });
      }
      if (message.t === 'init') {
        const online = normalizeOnline(message.online);
        if (online) this.online = online;
      }
      this.refreshSnapshot();
      return;
    }
    if (message.t === 'presence') {
      const online = normalizeOnline(message.online);
      if (online) this.online = online;
      if ('members' in message) {
        const members = normalizeMembers(message.members);
        if (members && this.base) {
          this.base = { ...this.base, members };
          this.updateQueryCache(this.base);
        }
      }
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

  private acceptSnapshot(response: unknown): void {
    const incoming = normalizeBase(this.listId, response);
    if (!incoming) return;
    if (this.terminalState || (this.base && incoming.revision < this.base.revision)) return;
    this.base = incoming;
    this.retireAcknowledged();
    this.reconcile();
    this.updateQueryCache(this.base);
    this.pump();
  }

  private acceptAcknowledgement(message: AckMessage): void {
    const operationId = message.opId || message.operationId;
    if (!operationId || (message.status !== 'accepted' && message.status !== 'rejected')) return;
    if (typeof message.revision !== 'number' || !Number.isInteger(message.revision) || message.revision < 0) return;
    const acknowledgedItem = message.item === undefined ? undefined : normalizeItem(message.item);
    if (message.item !== undefined && !acknowledgedItem) return;
    if (message.itemId !== undefined && !isNonEmptyString(message.itemId)) return;
    if (message.tempItemId !== undefined && !isNonEmptyString(message.tempItemId)) return;
    const idMap = message.idMap;
    if (idMap !== undefined && (!isRecord(idMap) || !isNonEmptyString(idMap.tempId) || !isNonEmptyString(idMap.itemId))) return;
    const index = this.pendingOperations.findIndex((operation) => operation.operationId === operationId);
    if (index === -1) return;
    const operation = this.pendingOperations[index];
    this.inFlight = this.inFlight === operationId ? null : this.inFlight;
    const revision = message.revision;
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
    if (acknowledgedItem) operation.serverItem = cloneItem(acknowledgedItem);
    if (message.itemId) operation.serverItemId = message.itemId;
    if (idMap?.itemId) operation.serverItemId = idMap.itemId;
    if (message.tempItemId && operation.tempItemId) operation.tempItemId = message.tempItemId;
    if (idMap?.tempId && operation.tempItemId) operation.tempItemId = idMap.tempId;
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
    const droppedTempId = dropped.kind === 'item:add' ? dropped.tempItemId : undefined;
    if (droppedTempId) {
      this.pendingOperations = this.pendingOperations.filter((candidate) => (
        candidate.payload.id !== droppedTempId
      ));
    }
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
            collected: false, createdAt: Date.now(), updatedAt: Date.now(), by: this.clientId, lastEditedBy: this.clientId,
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
      members: this.base?.members || [],
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
      members: base.members,
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
