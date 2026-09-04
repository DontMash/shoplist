import type { ListResponse } from './api';
import type { ListItem } from './list';
import type {
  ClientOperation,
  ListSessionTransport,
  SessionConnection,
  SessionConnectionOptions,
} from './list-session-transport';

interface AckDelivery {
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

  public connect(options: SessionConnectionOptions): SessionConnection {
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
  public deliverAck(ack: Omit<AckDelivery, 't'>, connection?: InMemorySessionConnection): void {
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
    private readonly options: SessionConnectionOptions,
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
