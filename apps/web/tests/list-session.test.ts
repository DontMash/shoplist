import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserListSessionTransport,
  createListSession,
  getListSessionCollection,
  InMemoryListSessionTransport,
  type ListSession,
  type SessionParticipant,
} from '../src/lib/list-session';
import { ApiError, createList, fetchList, responseFromSocket } from '../src/lib/api';
import type { ListResponse } from '../src/lib/api';

const openSessions: ListSession[] = [];

const item = (id: string, name = 'Milk') => ({
  id, name, amount: '', collected: false, createdAt: 1, updatedAt: 1,
});

const snapshot = (items = [item('item-1')], revision = 0, name = 'Groceries'): ListResponse => ({
  list: { id: 'list', name, createdAt: 1, revision }, items, memberCount: 1,
});

async function sessionFor(transport: InMemoryListSessionTransport, extra: Record<string, unknown> = {}): Promise<ListSession> {
  const session = createListSession({
    listId: 'list', clientId: 'client-a', name: 'Alice', transport,
    retryDelay: () => 60_000, ...extra,
  });
  openSessions.push(session);
  await tick();
  return session;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sent(transport: InMemoryListSessionTransport, kind: string) {
  return transport.sent.find((operation) => operation.kind === kind);
}

afterEach(() => {
  while (openSessions.length) openSessions.pop()?.close();
});

describe('list session', () => {
  it('retains cached state and accepts snapshots by revision', async () => {
    const transport = new InMemoryListSessionTransport(snapshot());
    transport.deferBootstrap = true;
    const session = await sessionFor(transport, { initialSnapshot: snapshot([item('cached')], 1, 'Cached') });

    expect(session.getSnapshot()).toMatchObject({ revision: 1, status: 'live', items: [item('cached')] });
    const unsubscribe = session.subscribe(() => undefined);
    expect(getListSessionCollection(session).toArray).toHaveLength(1);
    unsubscribe();
    transport.deliver({
      t: 'state', list: { id: 'list', name: 'Remote', createdAt: 1, revision: 3, items: [item('remote')] },
    });
    expect(session.getSnapshot()).toMatchObject({ revision: 3, items: [item('remote')], list: { name: 'Remote' } });
    transport.deliver({
      t: 'state', list: { id: 'list', name: 'Old', createdAt: 1, revision: 2, items: [item('old')] },
    });
    expect(session.getSnapshot().items.map((entry) => entry.id)).toEqual(['remote']);
    transport.resolveBootstrap(snapshot([item('rest-old')], 2, 'REST old'));
    await tick();
    expect(session.getSnapshot()).toMatchObject({ revision: 3, list: { name: 'Remote' } });

    const online: SessionParticipant[] = [{ clientId: 'client-b', name: 'Bob', color: '#123' }];
    transport.deliver({ t: 'presence', online });
    expect(session.getSnapshot().online).toEqual(online);
    const noRevision = createListSession({
      listId: 'list', clientId: 'client-a', autoStart: false,
      initialSnapshot: { ...snapshot(), list: { ...snapshot().list, revision: undefined } } as unknown as ListResponse,
      transport: new InMemoryListSessionTransport(snapshot()),
    });
    openSessions.push(noRevision);
    expect(noRevision.getSnapshot().revision).toBe(0);
  });

  it('optimistically replaces an add identity and waits before sending dependent edits', async () => {
    const transport = new InMemoryListSessionTransport(snapshot([]));
    const session = await sessionFor(transport);
    const temporaryId = session.addItem({ name: 'Eggs', amount: '6' });
    expect(session.getSnapshot().items).toHaveLength(1);
    expect(session.getSnapshot().items[0].id).toBe(temporaryId);
    const add = sent(transport, 'item:add')!;

    const editId = session.updateItem(temporaryId, { name: 'Free range eggs' });
    expect(editId).toBeTruthy();
    expect(transport.sent.filter((operation) => operation.kind === 'item:update')).toHaveLength(0);
    transport.deliverAck({
      opId: add.operationId, status: 'accepted', revision: 1, itemId: 'server-item', tempItemId: temporaryId,
      item: { ...item('server-item', 'Eggs'), amount: '6' },
    });
    expect(session.getSnapshot().items).toEqual([expect.objectContaining({ id: 'server-item', name: 'Free range eggs' })]);
    const edit = sent(transport, 'item:update')!;
    expect(edit.payload.id).toBe('server-item');
    transport.deliverAck({ opId: edit.operationId, status: 'accepted', revision: 2 });
    transport.deliverSnapshot(snapshot([{ ...item('server-item', 'Free range eggs'), amount: '6' }], 2));
    expect(session.getSnapshot()).toMatchObject({ pending: false, revision: 2 });
  });

  it('coalesces queued fields and rolls back only a rejected operation', async () => {
    const transport = new InMemoryListSessionTransport(snapshot());
    const session = await sessionFor(transport);
    const first = session.updateItem('item-1', { name: 'A' })!;
    const second = session.updateItem('item-1', { name: 'B', amount: '2' })!;
    expect(second).not.toBe(first);
    expect(transport.sent).toHaveLength(1);
    transport.deliverAck({ opId: first, status: 'rejected', revision: 0, reason: 'item-not-found' });
    expect(session.getSnapshot().items[0]).toMatchObject({ name: 'B', amount: '2' });
    expect(transport.sent).toHaveLength(2);
    transport.deliverAck({ opId: second, status: 'rejected', revision: 0, reason: 'item-not-found' });
    expect(session.getSnapshot().items[0]).toMatchObject({ name: 'Milk', amount: '' });
    expect(session.getLatestOutcome()).toMatchObject({ kind: 'rejected', operationId: second, reason: 'item-not-found' });
  });

  it('preserves structural order for offline work and drops edits after deletion', async () => {
    const transport = new InMemoryListSessionTransport(snapshot([item('item-1'), item('item-2')]));
    transport.autoOpen = false;
    const session = await sessionFor(transport, { autoStart: false, initialSnapshot: snapshot([item('item-1'), item('item-2')]), maxPending: 10 });
    const one = session.updateItem('item-1', { name: 'A' })!;
    const two = session.updateItem('item-1', { name: 'B' })!;
    expect(two).toBe(one);
    expect(session.deleteItem('item-1')).toBeTruthy();
    expect(session.updateItem('item-1', { name: 'C' })).toBeNull();
    expect(session.collectItem('missing')).toBeNull();
    expect(session.updateItem('item-2', { name: 'Other item' })).toBeTruthy();
    const temp = session.addItem({ name: 'New' });
    expect(session.deleteItem(temp)).toBeTruthy();
    expect(session.getSnapshot().items).toEqual([expect.objectContaining({ id: 'item-2', name: 'Other item' })]);
    session.start();
    transport.open();
    await tick();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].kind).toBe('item:update');

    const emptyTransport = new InMemoryListSessionTransport(snapshot([]));
    const emptySession = await sessionFor(emptyTransport);
    emptySession.clearList();
    const emptyDelete = emptySession.deleteList()!;
    emptyTransport.deliverAck({ opId: emptyDelete, status: 'rejected' });

    const fullTransport = new InMemoryListSessionTransport(snapshot([]));
    fullTransport.autoOpen = false;
    const full = await sessionFor(fullTransport, { autoStart: false, initialSnapshot: snapshot([]), maxPending: 2 });
    full.addItem({ name: 'one' });
    full.addItem({ name: 'two' });
    full.addItem({ name: 'three' });
    expect(full.getSnapshot().pendingCount).toBe(2);
    expect(full.getLatestOutcome()).toMatchObject({ kind: 'rejected', reason: 'outbox-full' });
  });

  it('replays the same operation ID after reconnecting', async () => {
    const transport = new InMemoryListSessionTransport(snapshot([]));
    const session = await sessionFor(transport);
    session.addItem({ name: 'Milk' });
    const operationId = transport.sent[0].operationId;
    transport.disconnect();
    expect(session.getStatus()).toBe('reconnecting');
    session.kick();
    await tick();
    expect(transport.sent.filter((operation) => operation.operationId === operationId)).toHaveLength(2);
    transport.deliverAck({ opId: operationId, status: 'accepted', revision: 1, itemId: 'canonical', item: item('canonical') });
    transport.deliverSnapshot(snapshot([item('canonical')], 1));
    expect(session.getSnapshot().pending).toBe(false);
  });

  it('removes dependent work when an optimistic add is rejected', async () => {
    const transport = new InMemoryListSessionTransport(snapshot([]));
    const session = await sessionFor(transport);
    const temporaryId = session.addItem({ name: 'Never saved' });
    session.updateItem(temporaryId, { amount: '1' });
    const add = transport.sent[0];
    transport.deliverAck({ opId: add.operationId, status: 'rejected', revision: 0, reasonCode: 'name-required' });
    expect(session.getSnapshot().items).toEqual([]);
    expect(session.getSnapshot().pending).toBe(false);
  });

  it('translates an ID map even when acknowledgement arrives before the snapshot', async () => {
    const transport = new InMemoryListSessionTransport(snapshot([]));
    transport.autoOpen = false;
    const session = await sessionFor(transport, { autoStart: false, initialSnapshot: snapshot([]) });
    session.start();
    transport.open();
    await tick();
    const temporaryId = session.addItem({ name: 'Eggs' });
    const editId = session.updateItem(temporaryId, { name: 'Eggs, free range' })!;
    const add = transport.sent.find((operation) => operation.kind === 'item:add')!;
    transport.deliverAck({ operationId: add.operationId, status: 'accepted', revision: 1, idMap: { tempId: temporaryId, itemId: 'canonical' } });
    transport.deliverSnapshot(snapshot([item('canonical', 'Eggs')], 1));
    expect(transport.sent.find((operation) => operation.operationId === editId)?.payload.id).toBe('canonical');
    expect(session.getSnapshot().items).toEqual([expect.objectContaining({ id: 'canonical', name: 'Eggs, free range' })]);
  });

  it('handles all list commands and terminal outcomes through the public interface', async () => {
    const transport = new InMemoryListSessionTransport(snapshot());
    const session = await sessionFor(transport);
    const collect = session.collectItem('item-1')!;
    transport.deliverAck({ opId: collect, status: 'accepted', revision: 1 });
    const clear = session.clearList()!;
    transport.deliverAck({ opId: clear, status: 'accepted', revision: 2 });
    const rename = session.renameList('New name')!;
    expect(session.getSnapshot().list?.name).toBe('New name');
    transport.deliverAck({ opId: rename, status: 'accepted', revision: 3 });
    transport.deliverSnapshot(snapshot([], 3, 'New name'));
    expect(session.deleteItem('item-1')).toBeNull();
    expect(session.renameList('')).toBeNull();

    const rejectDelete = session.deleteList('wrong')!;
    transport.deliverAck({ opId: rejectDelete, status: 'rejected', revision: 3, reason: 'not-owner', message: 'Only owner' });
    expect(session.getStatus()).toBe('live');
    expect(session.getLatestOutcome()).toMatchObject({ kind: 'rejected', reason: 'not-owner' });

    const deleteTransport = new InMemoryListSessionTransport(snapshot());
    const deleting = await sessionFor(deleteTransport);
    const operationId = deleting.deleteList()!;
    deleteTransport.deliverAck({ opId: operationId, status: 'accepted', revision: 1 });
    expect(deleting.getSnapshot()).toMatchObject({ status: 'deleted', outcome: { kind: 'deleted' }, pending: false });
    deleteTransport.deliver({ t: 'closed', reason: 'deleted' });
    expect(deleting.getStatus()).toBe('deleted');

    const missingTransport = new InMemoryListSessionTransport(snapshot());
    const missing = await sessionFor(missingTransport);
    missing.addItem({ name: 'Queued before list disappeared' });
    missingTransport.disconnect(4004, 'list-not-found');
    expect(missing.getSnapshot()).toMatchObject({ status: 'missing', outcome: { kind: 'missing' }, pending: false });
  });

  it('normalizes REST and websocket responses while preserving query errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/lists/')) return new Response(JSON.stringify(snapshot()), { status: 200 });
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ list: { id: 'created', name: 'Created', createdAt: 1 }, ownerToken: 'owner' }), { status: 201 });
    }) as typeof fetch;
    await expect(fetchList('list')).resolves.toMatchObject({ list: { revision: 0 } });
    await expect(createList('Created')).resolves.toMatchObject({ ownerToken: 'owner' });
    const normalized = responseFromSocket({ id: 'list', name: 'Socket', createdAt: 1, items: [], revision: 4 }, {
      ...snapshot(), memberCount: 2,
    });
    expect(normalized).toMatchObject({ list: { name: 'Socket', revision: 4 }, memberCount: 2 });
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(fetchList('missing')).rejects.toMatchObject({ status: 404 });
    globalThis.fetch = (async () => new Response('{', { status: 200 })) as typeof fetch;
    await expect(fetchList('bad')).rejects.toThrow('invalid response');
    globalThis.fetch = originalFetch;
    expect(new ApiError(409).status).toBe(409);
  });

  it('handles malformed deliveries, adapter lifecycle, and query cache interop safely', async () => {
    const transport = new InMemoryListSessionTransport();
    transport.autoOpen = false;
    transport.deferBootstrap = true;
    const session = await sessionFor(transport, { autoStart: false, initialSnapshot: snapshot() });
    session.start();
    session.start();
    expect(() => transport.connections[0].send({ operationId: 'bad', kind: 'list:clear', payload: {} })).toThrow();
    transport.deliver(null);
    transport.deliver({});
    transport.deliver({ t: 'state', list: { id: 'other', name: 'Other', createdAt: 0, revision: 9, items: [] } });
    transport.deliver({ t: 'state', list: { id: 'list', name: 'List', createdAt: 0, revision: 1, items: 'bad' } });
    transport.deliver({ t: 'ack' });
    transport.deliver({ t: 'ack', operationId: 'unknown', status: 'accepted', revision: 1 });
    transport.open();
    transport.connections[0].open();
    transport.deliver({ t: 'init', list: { id: 'list', name: 'List', createdAt: 0, items: [] }, online: [] }, transport.connections[0]);
    transport.deliver({ t: 'presence', online: [] }, transport.connections[0]);
    transport.deliver({ t: 'error', message: 'Only owner' }, transport.connections[0]);
    transport.deliverAck({ operationId: 'unknown', status: 'accepted' }, transport.connections[0]);
    transport.deliverSnapshot(snapshot([], 1), transport.connections[0]);
    transport.rejectBootstrap();
    transport.connections[0].close();
    transport.connections[0].close();
    session.kick();
    session.close();
    session.kick();
    session.start();

    const queryClient = new (await import('@tanstack/react-query')).QueryClient();
    const cached = await sessionFor(new InMemoryListSessionTransport(snapshot()), { queryClient });
    expect(queryClient.getQueryData(['lists', 'list'])).toMatchObject({ list: { revision: 0 } });
    cached.close();
    queryClient.setQueryData(['lists', 'list'], snapshot([], 9));
    const newerCache = await sessionFor(new InMemoryListSessionTransport(snapshot([], 1)), { queryClient });
    expect(newerCache.getSnapshot().revision).toBe(9);
    newerCache.close();

    const failedTransport = {
      fetchSnapshot: vi.fn(async () => { throw new Error('offline'); }),
      connect: vi.fn(() => { throw new Error('cannot connect'); }),
    };
    const failed = createListSession({ listId: 'list', clientId: 'client-a', transport: failedTransport, retryDelay: () => 60_000 });
    openSessions.push(failed);
    await tick();
    expect(failed.getStatus()).toBe('reconnecting');

    const closedTransport = new InMemoryListSessionTransport(snapshot());
    const closedSession = await sessionFor(closedTransport);
    closedTransport.deliver({ t: 'closed', reason: 'deleted' });
    closedTransport.deliver({ t: 'closed', reason: 'deleted' });
    expect(closedSession.getStatus()).toBe('deleted');
    const missingMessageTransport = new InMemoryListSessionTransport(snapshot());
    const missingMessageSession = await sessionFor(missingMessageTransport);
    missingMessageTransport.deliver({ t: 'closed', reason: 'missing' });
    expect(missingMessageSession.getStatus()).toBe('missing');

    const offlineTransport = new InMemoryListSessionTransport(snapshot());
    const offlineSession = await sessionFor(offlineTransport);
    const oldOnline = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    offlineTransport.disconnect();
    expect(offlineSession.getStatus()).toBe('offline');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: oldOnline });
    offlineSession.close();

    const reconnectTransport = new InMemoryListSessionTransport(snapshot([]));
    reconnectTransport.autoOpen = false;
    const reconnecting = await sessionFor(reconnectTransport, { retryDelay: () => 0 });
    reconnectTransport.connections[0].closeFromPeer();
    await tick();
    reconnectTransport.open();
    reconnecting.close();
  });

  it('covers the browser transport wire lifecycle', () => {
    const RealWebSocket = globalThis.WebSocket;
    const RealLocation = globalThis.location;
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
    class FakeWebSocket {
      public static OPEN = 1;
      public static instances: FakeWebSocket[] = [];
      public readyState = 0;
      public onopen: (() => void) | null = null;
      public onmessage: ((event: { data: string }) => void) | null = null;
      public onclose: ((event: { code: number; reason: string }) => void) | null = null;
      public onerror: (() => void) | null = null;
      public sent: string[] = [];
      public constructor() { FakeWebSocket.instances.push(this); }
      public send(value: string): void { this.sent.push(value); }
      public close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'closed' }); }
      public open(): void { this.readyState = 1; this.onopen?.(); }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const received: unknown[] = [];
    const closed: unknown[] = [];
    const connection = browserListSessionTransport.connect({
      listId: 'list', clientId: 'client-a', name: '',
      onOpen: () => received.push('open'), onMessage: (message) => received.push(message),
      onClose: (info) => closed.push(info),
    });
    const fake = FakeWebSocket.instances[0];
    expect(() => connection.send({ operationId: 'not-open', kind: 'list:clear', payload: {} })).toThrow();
    fake.open();
    fake.onmessage?.({ data: '{' });
    fake.onmessage?.({ data: '{"t":"pong"}' });
    connection.send({ operationId: 'x', kind: 'item:add', payload: { tempItemId: 't', name: 'Milk', amount: '' } });
    connection.send({ operationId: 'x2', kind: 'item:update', payload: { id: 'i', patch: {} } });
    connection.send({ operationId: 'x3', kind: 'item:delete', payload: { id: 'i' } });
    connection.send({ operationId: 'x4', kind: 'list:clear', payload: {} });
    connection.send({ operationId: 'x5', kind: 'list:rename', payload: { name: 'X' } });
    connection.send({ operationId: 'x6', kind: 'list:delete', payload: { ownerToken: 'o' } });
    fake.onerror?.();
    connection.close();
    expect(() => connection.send({ operationId: 'closed', kind: 'list:clear', payload: {} })).toThrow();
    globalThis.WebSocket = RealWebSocket;
    vi.stubGlobal('location', RealLocation);
    expect(received).toEqual(['open', { t: 'pong' }]);
    expect(closed).toEqual([{ code: 1000, reason: 'closed' }, { code: 1000, reason: 'closed' }]);
  });

  it('rebases local offline work over concurrent clear and rename snapshots', async () => {
    const clearTransport = new InMemoryListSessionTransport(snapshot());
    clearTransport.autoOpen = false;
    const clearSession = await sessionFor(clearTransport, { initialSnapshot: snapshot() });
    clearTransport.deliverSnapshot(snapshot([], 1));
    clearSession.addItem({ name: 'Local add' });
    expect(clearSession.getSnapshot().items).toEqual([expect.objectContaining({ name: 'Local add' })]);

    const renameTransport = new InMemoryListSessionTransport(snapshot());
    renameTransport.autoOpen = false;
    const renameSession = await sessionFor(renameTransport, { initialSnapshot: snapshot() });
    renameTransport.deliverSnapshot(snapshot([item('item-1')], 1, 'Remote name'));
    renameSession.renameList('Local name');
    expect(renameSession.getSnapshot().list?.name).toBe('Local name');
  });

  it('keeps collections isolated between list sessions', async () => {
    const firstTransport = new InMemoryListSessionTransport(snapshot([item('a')]));
    const secondTransport = new InMemoryListSessionTransport({
      ...snapshot([item('b')]), list: { ...snapshot().list, id: 'other-list' },
    });
    const first = await sessionFor(firstTransport);
    const second = createListSession({ listId: 'other-list', clientId: 'client-a', transport: secondTransport });
    openSessions.push(second);
    await tick();
    firstTransport.deliverSnapshot(snapshot([item('a-2')], 1));
    expect(first.getSnapshot().items.map((entry) => entry.id)).toEqual(['a-2']);
    expect(second.getSnapshot().items.map((entry) => entry.id)).toEqual(['b']);
  });
});
