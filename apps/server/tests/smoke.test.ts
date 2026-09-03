import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  broadcast,
  colorFor,
  createApp,
  messageText,
  onlineIn,
  publicItem,
  sameOrigin,
  startServer,
  type RunningServer,
} from '../src/server.js';
import { Store } from '../src/store.js';

describe('Store', () => {
  it('creates, validates, updates, and deletes lists and items', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-basic-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    const list = store.createList('  Weekend groceries  ');
    expect(list.name).toBe('Weekend groceries');
    expect(store.addItem(list, { name: ' Milk ', amount: '2 L' }, 'client-a')).toMatchObject({
      name: 'Milk', amount: '2 L', collected: false, by: 'client-a',
    });
    expect(store.addItem(list, { name: '  ' }, 'client-a')).toBeNull();
    const item = list.items[0];
    expect(store.updateItem(list, item.id, { collected: true, amount: '3 L' })).toBe(true);
    expect(item).toMatchObject({ collected: true, amount: '3 L' });
    expect(store.updateItem(list, item.id, { name: ' ' })).toBe(false);
    expect(store.deleteItem(list, item.id)).toBe(true);
    expect(store.deleteItem(list, item.id)).toBe(false);
    expect(store.deleteList(list.id)).toBe(true);
    expect(store.getList(list.id)).toBeNull();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists revisions and idempotent operation outcomes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-operations-'));
    const file = path.join(directory, 'db.sqlite');
    const store = new Store(file);
    const list = store.createList('Operations');
    const add = store.applyOperation(list.id, {
      operationId: 'op-add', kind: 'item:add', actorClientId: 'client-a',
      payload: { tempItemId: 'temp-add', name: 'Milk', amount: '2 L' },
    });
    expect(add.ack).toMatchObject({ opId: 'op-add', status: 'accepted', revision: 1, tempItemId: 'temp-add' });
    expect(add.ack.itemId).toBeTruthy();
    expect(store.getList(list.id)?.revision).toBe(1);
    expect(store.applyOperation(list.id, {
      operationId: 'op-add', kind: 'item:add', actorClientId: 'client-a',
      payload: { tempItemId: 'temp-add', name: 'Duplicate' },
    })).toMatchObject({ duplicate: true, ack: add.ack });
    expect(store.getList(list.id)?.revision).toBe(1);

    const itemId = add.ack.itemId as string;
    expect(store.applyOperation(list.id, {
      operationId: 'op-update', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { amount: '3 L', collected: true } },
    }).ack).toMatchObject({ status: 'accepted', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-reject', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { name: ' ' } },
    }).ack).toMatchObject({ status: 'rejected', reason: 'name-required', reasonCode: 'name-required', revision: 2 });
    expect(store.getList(list.id)?.revision).toBe(2);
    expect(store.applyOperation(list.id, {
      operationId: 'op-empty-patch', kind: 'item:update', actorClientId: 'client-a', payload: { id: itemId, patch: {} },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-add-amount', kind: 'item:add', actorClientId: 'client-a', payload: { name: 'Bad', amount: 2 },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-update-type', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { collected: 'false' } },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-rename-type', kind: 'list:rename', actorClientId: 'client-a', payload: { name: 42 },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });

    const second = store.applyOperation(list.id, {
      operationId: 'op-second', kind: 'item:add', actorClientId: null,
      payload: { name: 'Bread' },
    });
    expect(store.applyOperation(list.id, {
      operationId: 'op-delete', kind: 'item:delete', actorClientId: 'client-a',
      payload: { id: second.ack.itemId },
    }).ack).toMatchObject({ status: 'accepted', revision: 4 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-clear', kind: 'list:clear', actorClientId: 'client-a', payload: {},
    }).ack).toMatchObject({ status: 'accepted', revision: 5 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-rename', kind: 'list:rename', actorClientId: 'client-a', payload: { name: 'Renamed' },
    }).ack).toMatchObject({ status: 'accepted', revision: 6 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-rename', kind: 'list:rename', actorClientId: 'client-a', payload: { name: 'Other' },
    })).toMatchObject({ duplicate: true, ack: expect.objectContaining({ revision: 6 }) });
    expect(store.applyOperation(list.id, {
      operationId: 'op-not-owner', kind: 'list:delete', actorClientId: 'client-b', payload: { ownerToken: 'wrong' },
    }).ack).toMatchObject({ status: 'rejected', reason: 'not-owner', revision: 6 });
    expect(store.getList(list.id)?.revision).toBe(6);
    expect(store.applyOperation(list.id, {
      operationId: 'op-missing-item', kind: 'item:delete', actorClientId: 'client-a', payload: { id: 'missing' },
    }).ack).toMatchObject({ status: 'rejected', reason: 'item-not-found', revision: 6 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-missing-item-2', kind: 'item:update', actorClientId: 'client-a', payload: { id: 'missing', patch: {} },
    }).ack).toMatchObject({ status: 'rejected', reason: 'item-not-found', revision: 6 });
    expect(store.applyOperation('gone-list', {
      operationId: 'op-gone', kind: 'list:rename', actorClientId: 'client-a', payload: { name: 'Gone' },
    }).ack).toMatchObject({ status: 'rejected', reason: 'list-not-found', revision: 0 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-invalid-kind', kind: 'unsupported' as any, actorClientId: 'client-a', payload: {},
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-operation', revision: 6 });
    expect(store.applyOperation(list.id, {
      operationId: '', kind: 'list:clear', actorClientId: 'client-a', payload: {},
    }).ack).toMatchObject({ status: 'rejected', reason: 'operation-too-large', revision: 6 });
    expect(store.applyOperation(list.id, {
      operationId: null as any, kind: 'list:clear', actorClientId: 'client-a', payload: {},
    }).ack).toMatchObject({ status: 'rejected', reason: 'operation-too-large', revision: 6 });
    const oversizedOperation = store.applyOperation(list.id, {
      operationId: 'x'.repeat(161), kind: 'list:clear', actorClientId: 'client-a', payload: {},
    });
    expect(oversizedOperation.ack).toMatchObject({ status: 'rejected', reason: 'operation-too-large' });
    expect(store.applyOperation(list.id, {
      operationId: 'x'.repeat(161), kind: 'list:rename', actorClientId: 'client-a', payload: { name: 'ignored' },
    })).toMatchObject({ duplicate: true, ack: oversizedOperation.ack });
    expect(store.applyOperation(list.id, {
      operationId: 'op-invalid-kind', kind: 'list:clear', actorClientId: 'client-a', payload: {},
    })).toMatchObject({ duplicate: true, ack: expect.objectContaining({ reason: 'invalid-operation' }) });

    store.close();
    const reloaded = new Store(file);
    expect(reloaded.getList(list.id)?.revision).toBe(6);
    expect(reloaded.applyOperation(list.id, {
      operationId: 'op-add', kind: 'item:add', actorClientId: 'client-a', payload: { name: 'Again' },
    })).toMatchObject({ duplicate: true, ack: expect.objectContaining({ itemId, revision: 1 }) });
    const deletion = reloaded.applyOperation(list.id, {
      operationId: 'op-owner-delete', kind: 'list:delete', actorClientId: 'client-a', payload: { ownerToken: list.ownerToken },
    });
    expect(deletion).toMatchObject({ ack: { status: 'accepted', revision: 7 }, terminal: true, list: null });
    expect(reloaded.applyOperation(list.id, {
      operationId: 'op-owner-delete', kind: 'list:delete', actorClientId: 'client-a', payload: { ownerToken: list.ownerToken },
    })).toMatchObject({ duplicate: true, ack: deletion.ack });
    reloaded.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps SQLite canonical across reloads and handles edge input', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-store-'));
    const file = path.join(directory, 'db.sqlite');
    const store = new Store(file);

    expect(store.listCount()).toBe(0);
    expect(store.getList(undefined)).toBeNull();
    expect(store.getList('missing')).toBeNull();
    expect(store.createList(undefined).name).toBe('Shopping list');
    const list = store.createList('  Main list  ');
    expect(store.listCount()).toBe(2);
    expect(store.renameList(list, ' ')).toBe(false);
    expect(store.renameList(list, '  Renamed  ')).toBe(true);
    expect(list.name).toBe('Renamed');

    expect(store.addItem(list, { name: 42 as unknown as string }, null)).toBeNull();
    const item = store.addItem(list, { name: 'Bread', amount: 42 as unknown as string }, '');
    expect(item).toMatchObject({ name: 'Bread', amount: '', by: null });
    expect(store.updateItem(list, 'missing', {})).toBe(false);
    expect(store.updateItem(list, item!.id, {
      name: '  Whole-grain bread  ', amount: '1 loaf', collected: 1,
    })).toBe(true);
    expect(item).toMatchObject({ name: 'Whole-grain bread', amount: '1 loaf', collected: true });
    expect(store.updateItem(list, item!.id, { name: ' ' })).toBe(false);
    expect(store.deleteItem(list, 'missing')).toBe(false);

    store.touchMember(list, 'client-a', ' ', '#123456');
    const joinedAt = list.members['client-a'].joinedAt;
    store.touchMember(list, 'client-a', 'Alice', '#abcdef');
    expect(list.members['client-a']).toMatchObject({ name: 'Alice', color: '#abcdef', joinedAt });
    expect(store.memberCount(list)).toBe(1);
    expect(store.memberCount({ members: undefined } as any)).toBe(0);
    const detached = store.addItem(list, { name: 'Temporary' }, null)!;
    list.items.pop();
    expect(store.deleteItem(list, detached.id)).toBe(true);

    const reloaded = new Store(file);
    expect(reloaded.getList(list.id)).toMatchObject({
      name: 'Renamed',
      items: [{ name: 'Whole-grain bread', amount: '1 loaf', collected: true }],
      members: { 'client-a': { name: 'Alice', color: '#abcdef' } },
    });
    reloaded.close();

    store.clearList(list);
    expect(list.items).toEqual([]);
    expect(list.clearedAt).toEqual(expect.any(Number));
    expect(store.deleteList('missing')).toBe(false);
    expect(store.deleteList(list.id)).toBe(true);
    expect(store.listCount()).toBe(1);
    store.close();
    store.close();
    store.flushSync();
    await rm(directory, { recursive: true, force: true });
  });

  it('imports malformed legacy records without trusting their shape', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-malformed-'));
    const file = path.join(directory, 'db.json');
    await writeFile(file, JSON.stringify({
      lists: {
        nullList: null,
        primitiveList: 'not a list',
        arrayList: [],
        fallback: {
          name: null, ownerToken: null, createdAt: 'bad', clearedAt: 'bad',
          items: [null, 'bad item', [], {}, { id: 42, name: ' Valid ', amount: 42, collected: 1, by: '' }],
          members: {
            '': { clientId: '', name: 'ignored', color: '#000', joinedAt: 1 },
            empty: null,
            primitive: 'bad member',
            array: [],
            fallback: { clientId: '', name: ' ', color: '', joinedAt: 'bad' },
          },
        },
        'bad/key': { id: 'bad/id', name: 'Generated ID', items: [], members: {} },
      },
    }));
    const store = new Store(file);
    const list = store.getList('fallback');
    expect(list).toMatchObject({ name: 'Shopping list', ownerToken: expect.any(String) });
    expect(list?.items).toHaveLength(1);
    expect(list?.items[0]).toMatchObject({ name: 'Valid', collected: true, by: null });
    expect(list?.members).toEqual({
      fallback: expect.objectContaining({ name: 'Guest', color: '#888888' }),
    });
    expect(store.listCount()).toBe(2);
    expect(store.getList('bad/key')).toBeNull();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('backs up invalid JSON and migrates SQLite files with the old JSON name', async () => {
    const invalidDirectory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-invalid-'));
    const invalidFile = path.join(invalidDirectory, 'db.json');
    await writeFile(invalidFile, '{not-json');
    const invalidStore = new Store(invalidFile);
    expect(invalidStore.listCount()).toBe(0);
    invalidStore.close();
    expect((await readdir(invalidDirectory)).some((name) => name.startsWith('db.json.legacy-'))).toBe(true);

    const brokenStore = new Store(path.join(invalidDirectory, 'broken.sqlite'));
    const checkpointError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (brokenStore as any).sqlite.close();
    brokenStore.flushSync();
    expect(checkpointError).toHaveBeenCalledWith('[store] checkpoint failed:', expect.any(String));
    checkpointError.mockRestore();
    await rm(invalidDirectory, { recursive: true, force: true });

    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-old-sqlite-name-'));
    const oldFile = path.join(directory, 'db.json');
    const oldStore = new Store(oldFile);
    const oldList = oldStore.createList('Old SQLite');
    oldStore.close();
    const newFile = path.join(directory, 'db.sqlite');
    const migratedStore = new Store(newFile);
    expect(await fileExists(oldFile)).toBe(false);
    expect(migratedStore.getList(oldList.id)?.name).toBe('Old SQLite');
    migratedStore.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('migrates the removed shopped flag when loading old data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-migration-'));
    const file = path.join(directory, 'db.json');
    await writeFile(file, JSON.stringify({
      lists: {
        legacy: {
          id: 'legacy', name: 'Legacy', ownerToken: 'owner', createdAt: 1,
          clearedAt: null, members: {},
          items: [{ id: 'item', name: 'Bread', amount: '', shopped: true, collected: 0 }],
        },
      },
    }));
    const store = new Store(file);
    expect(store.getList('legacy')?.items[0]).not.toHaveProperty('shopped');
    expect(store.getList('legacy')?.items[0].collected).toBe(false);
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe('server helpers', () => {
  it('handles protocol values, origins, presence, and broadcasts defensively', () => {
    expect(messageText('plain text')).toBe('plain text');
    expect(messageText(new TextEncoder().encode('bytes'))).toBe('bytes');
    expect(messageText(new Uint8Array([97, 114, 114, 97, 121]))).toBe('array');
    expect(messageText(new Uint8Array([97, 98]).buffer)).toBe('ab');
    expect(messageText([111, 107])).toBe('ok');
    expect(messageText({})).toBe('');

    const request = new Request('http://example.test/healthz', { headers: { host: 'example.test' } });
    expect(sameOrigin(request)).toBe(true);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'http://example.test' } }))).toBe(true);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'https://evil.example' } }))).toBe(false);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'https://example.test' } }))).toBe(false);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'not-a-url' } }))).toBe(false);

    const first = { clientId: 'same', name: 'First', color: colorFor('same') };
    const duplicate = { clientId: 'same', name: 'Second', color: colorFor('same') };
    const other = { clientId: 'other', name: 'Other', color: colorFor('other') };
    const firstSocket = { readyState: 1, send: vi.fn() };
    const duplicateSocket = { readyState: 1, send: vi.fn() };
    const otherSocket = { readyState: 0, send: vi.fn() };
    const throwingSocket = { readyState: 1, send: vi.fn(() => { throw new Error('closed'); }) };
    const room = new Map<any, any>([
      [firstSocket, first], [duplicateSocket, duplicate], [otherSocket, other], [throwingSocket, other],
    ]);
    const rooms = new Map<string, Map<any, any>>([['room', room]]);
    expect(onlineIn(rooms, 'missing')).toEqual([]);
    expect(onlineIn(rooms, 'room')).toEqual([first, other]);
    broadcast(rooms, 'missing', { t: 'noop' });
    broadcast(rooms, 'room', { t: 'state' }, firstSocket as any);
    expect(duplicateSocket.send).toHaveBeenCalledWith('{"t":"state"}');
    expect(otherSocket.send).not.toHaveBeenCalled();
    expect(throwingSocket.send).toHaveBeenCalled();
    broadcast(rooms, 'room', { t: 'state' }, undefined);
    expect(firstSocket.send).toHaveBeenCalledTimes(1);

    const item = { id: 'item', name: 'Item', amount: '', collected: false, createdAt: 1, updatedAt: 1, by: null,
      shopped: true };
    expect(publicItem(item)).not.toHaveProperty('shopped');
  });
});

describe('Hono API and realtime server', () => {
  let directory: string;
  let running: RunningServer;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-server-'));
    await mkdir(path.join(directory, 'public'));
    await writeFile(path.join(directory, 'public', 'index.html'), '<!doctype html><title>Shoplist</title>');
    await new Promise<void>((resolve) => {
      running = startServer({
        host: '127.0.0.1',
        port: 0,
        dataFile: path.join(directory, 'db.json'),
        publicDir: path.join(directory, 'public'),
        onListening: (port) => {
          base = `http://127.0.0.1:${port}`;
          wsBase = `ws://127.0.0.1:${port}`;
          resolve();
        },
      });
    });
  });

  afterAll(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uses default app paths and turns route failures into safe errors', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-defaults-'));
    const previousDataDir = process.env.DATA_DIR;
    const previousPublicDir = process.env.PUBLIC_DIR;
    process.env.DATA_DIR = dataDirectory;
    delete process.env.PUBLIC_DIR;
    const resources = createApp();
    const tooLarge = await resources.app.request('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1' },
      body: 'x'.repeat(17 * 1024),
    });
    expect(tooLarge.status).toBe(413);
    const emptyBody = await resources.app.request('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(emptyBody.status).toBe(201);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(resources.store, 'createList').mockImplementation(() => {
      throw new Error('test failure');
    });
    const response = await resources.app.request('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'will fail' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    resources.store.close();
    await rm(dataDirectory, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousPublicDir === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = previousPublicDir;
  });

  it('serves the health endpoint and validates REST requests', async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await health.json()).toMatchObject({ ok: true, lists: 0 });

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>Shoplist</title>');
    expect((await fetch(`${base}/..%2f..%2fserver.js`)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/lists`, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(`${base}/api/lists`, { method: 'GET' })).status).toBe(405);
    expect((await fetch(`${base}/api/unknown`, { method: 'GET' })).status).toBe(405);
    expect((await fetch(`${base}/api/lists`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/lists`, { method: 'POST' })).status).toBe(415);
    expect((await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })).status).toBe(400);
    expect((await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '[]',
    })).status).toBe(201);
    expect((await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(17 * 1024) }),
    })).status).toBe(413);

    const response = await fetch(`${base}/api/lists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test list' }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { list: { id: string; name: string }; ownerToken: string };
    expect(created.list.name).toBe('Test list');
    expect(created.ownerToken).toHaveLength(16);

    const listResponse = await fetch(`${base}/api/lists/${created.list.id}`);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({ list: { id: created.list.id }, items: [], memberCount: 0 });
    expect((await fetch(`${base}/api/lists/bad`)).status).toBe(404);
    expect((await fetch(`${base}/api/lists/not-a-list`)).status).toBe(404);

    const qr = await fetch(`${base}/api/qr?data=${encodeURIComponent(`${base}/#/join/${created.list.id}`)}`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toContain('image/svg+xml');
    expect(await qr.text()).toContain('<svg');
    expect((await fetch(`${base}/api/qr`)).status).toBe(400);
    expect((await fetch(`${base}/api/qr?data=${'x'.repeat(513)}`)).status).toBe(400);
    expect((await fetch(`${base}/api/qr?data=${'x'.repeat(512)}`)).status).toBe(200);
    expect((await fetch(`${base}/favicon.ico`, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${base}/does-not-exist`)).status).toBe(404);
  });

  it('rejects websocket connections for unknown lists and missing clients', async () => {
    const unknownCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${wsBase}/ws?list=unknown-list&client=x&name=X`);
      socket.once('close', (closeCode) => resolve(closeCode));
      socket.once('error', () => { /* the close event carries the protocol code */ });
    });
    expect(unknownCode).toBe(4004);

    const created = await (await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Client validation' }),
    })).json() as { list: { id: string } };
    const missingListCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${wsBase}/ws?client=x&name=X`);
      socket.once('close', (closeCode) => resolve(closeCode));
      socket.once('error', () => { /* the close event carries the protocol code */ });
    });
    expect(missingListCode).toBe(4004);

    const missingClientCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${wsBase}/ws?list=${created.list.id}&name=X`);
      socket.once('close', (closeCode) => resolve(closeCode));
      socket.once('error', () => { /* the close event carries the protocol code */ });
    });
    expect(missingClientCode).toBe(4004);
  });

  it('handles websocket validation, every operation, and room cleanup', async () => {
    const created = await (await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Operations' }),
    })).json() as { list: { id: string }; ownerToken: string };
    const clientA = await connect(`${wsBase}/ws?list=${created.list.id}&client=guest&name=%20`);
    const clientB = await connect(`${wsBase}/ws?list=${created.list.id}&client=guest&name=Updated`);
    await waitFor(clientA.messages, (message) => message.t === 'init');
    await waitFor(clientB.messages, (message) => message.t === 'init');

    clientA.socket.send(JSON.stringify({}));
    clientA.socket.send(JSON.stringify({ t: 42 }));
    clientA.socket.send(JSON.stringify({ t: 'item:add', item: 'not-an-object' }));
    clientA.socket.send(JSON.stringify({ t: 'item:update' }));
    clientA.socket.send(JSON.stringify({ t: 'item:update', id: 'missing', patch: 'not-an-object' }));
    clientA.socket.send(JSON.stringify({ t: 'item:delete' }));
    clientA.socket.send(JSON.stringify({ t: 'item:delete', id: 'missing' }));
    clientA.socket.send(JSON.stringify({ t: 'unknown-operation' }));
    clientA.socket.send(JSON.stringify({ t: 'item:add', item: { name: 'Eggs' } }));
    const addState = await waitFor(clientB.messages, (message) => message.t === 'state' && message.list.items.length === 1);
    const itemId = addState.list.items[0].id as string;

    clientA.socket.send(JSON.stringify({ t: 'item:update', id: itemId, patch: {
      name: '  Free range eggs ', amount: '6', collected: true,
    } }));
    const updateState = await waitFor(clientB.messages, (message) => message.t === 'state' && message.list.items[0]?.collected);
    expect(updateState.list.items[0]).toMatchObject({ name: 'Free range eggs', amount: '6', collected: true });
    clientA.socket.send(JSON.stringify({ t: 'item:update', id: itemId, patch: { name: ' ' } }));
    clientA.socket.send(JSON.stringify({ t: 'list:rename', name: ' ' }));
    clientA.socket.send(JSON.stringify({ t: 'list:rename', name: 'Renamed operations' }));
    expect((await waitFor(clientB.messages, (message) => message.t === 'state' && message.list.name === 'Renamed operations')).list.name)
      .toBe('Renamed operations');

    clientA.socket.send(JSON.stringify({ t: 'list:clear' }));
    expect((await waitFor(clientB.messages, (message) => message.t === 'state' && message.list.items.length === 0)).list.items)
      .toEqual([]);
    clientA.socket.send(JSON.stringify({ t: 'item:delete', id: itemId }));
    clientA.socket.send(JSON.stringify({ t: 'list:delete', ownerToken: 'wrong' }));
    await waitFor(clientA.messages, (message) => message.t === 'error');
    await close(clientA.socket);
    expect((await waitFor(clientB.messages, (message) => message.t === 'presence' && message.online.length === 1)).online)
      .toHaveLength(1);
    await close(clientB.socket);
    expect(running.rooms.has(created.list.id)).toBe(false);

    const deleted = await (await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Deleted during message' }),
    })).json() as { list: { id: string } };
    const deletedClient = await connect(`${wsBase}/ws?list=${deleted.list.id}&client=delete-me&name=Guest`);
    await waitFor(deletedClient.messages, (message) => message.t === 'init');
    running.store.deleteList(deleted.list.id);
    deletedClient.socket.send(JSON.stringify({ t: 'ping' }));
    const closeCode = await new Promise<number>((resolve) => deletedClient.socket.once('close', resolve));
    expect(closeCode).toBe(4004);
  });

  it('acknowledges identified operations and deduplicates replay', async () => {
    const created = await (await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Identified' }),
    })).json() as { list: { id: string }; ownerToken: string };
    const client = await connect(`${wsBase}/ws?list=${created.list.id}&client=identified&name=Guest`);
    await waitFor(client.messages, (message) => message.t === 'init' && message.list.revision === 0);
    client.socket.send(JSON.stringify({ t: 'item:add', opId: 'identified-add', tempId: 'tmp-1', item: { name: 'Eggs' } }));
    const ack = await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-add');
    expect(ack).toMatchObject({ status: 'accepted', revision: 1, tempItemId: 'tmp-1', item: { name: 'Eggs' } });
    const state = await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 1);
    const itemId = state.list.items[0].id;
    client.socket.send(JSON.stringify({ t: 'item:add', opId: 'identified-add', tempId: 'tmp-1', item: { name: 'Duplicate' } }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-add')).toEqual(ack);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.messages.some((message) => message.t === 'state' && message.list.revision === 2)).toBe(false);

    client.socket.send(JSON.stringify({ t: 'operation', operationId: 'identified-update', kind: 'item:update', payload: {
      id: itemId, patch: { collected: true },
    } }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-update'))
      .toMatchObject({ status: 'accepted', revision: 2 });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 2);
    client.socket.send(JSON.stringify({ t: 'list:delete', opId: 'identified-delete', ownerToken: 'wrong' }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-delete'))
      .toMatchObject({ status: 'rejected', reason: 'not-owner', reasonCode: 'not-owner', revision: 2 });

    client.socket.send(JSON.stringify({ t: 'operation', opId: 'identified-invalid', kind: 'unknown', payload: {} }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-invalid'))
      .toMatchObject({ status: 'rejected', reason: 'invalid-operation', revision: 2 });
    client.socket.send(JSON.stringify({ t: 'item:add', opId: 'x'.repeat(161), item: { name: 'Too large' } }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'x'.repeat(161)))
      .toMatchObject({ status: 'rejected', reason: 'operation-too-large', revision: 2 });
    client.socket.send(JSON.stringify({ t: 'item:update', opId: 'identified-compact-update', id: itemId, patch: { amount: '1' } }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-compact-update'))
      .toMatchObject({ status: 'accepted', revision: 3 });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 3);
    client.socket.send(JSON.stringify({ t: 'item:delete', opId: 'identified-item-delete', id: itemId }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-item-delete'))
      .toMatchObject({ status: 'accepted', revision: 4 });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 4);
    client.socket.send(JSON.stringify({ t: 'list:clear', opId: 'identified-clear' }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-clear'))
      .toMatchObject({ status: 'accepted', revision: 5 });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 5);
    client.socket.send(JSON.stringify({ t: 'list:rename', opId: 'identified-rename', name: 'Renamed' }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-rename'))
      .toMatchObject({ status: 'accepted', revision: 6 });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 6);
    client.socket.send(JSON.stringify({ t: 'operation', opId: 'identified-generic-add', kind: 'item:add', payload: {
      item: { name: 'Bread' }, tempItemId: 'temp-generic',
    } }));
    expect(await waitFor(client.messages, (message) => message.t === 'ack' && message.opId === 'identified-generic-add'))
      .toMatchObject({ status: 'accepted', revision: 7, tempItemId: 'temp-generic' });
    await waitFor(client.messages, (message) => message.t === 'state' && message.list.revision === 7);
    await close(client.socket);
  });

  it('syncs list operations between websocket clients and enforces ownership', async () => {
    const created = await (await fetch(`${base}/api/lists`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Realtime' }),
    })).json() as { list: { id: string }; ownerToken: string };

    const clientA = await connect(`${wsBase}/ws?list=${created.list.id}&client=a&name=Alice`);
    const clientB = await connect(`${wsBase}/ws?list=${created.list.id}&client=b&name=Bob`);
    expect((await waitFor(clientA.messages, (message) => message.t === 'init')).list.items).toEqual([]);
    await waitFor(clientB.messages, (message) => message.t === 'init');
    expect((await waitFor(clientA.messages, (message) => message.t === 'presence' &&
      message.online.some((person: Message) => person.clientId === 'b'))).online)
      .toEqual(expect.arrayContaining([expect.objectContaining({ clientId: 'b', name: 'Bob' })]));

    clientA.socket.send(JSON.stringify({ t: 'item:add', item: { name: 'Milk', amount: '2 L' } }));
    const state = await waitFor(clientB.messages, (message) => message.t === 'state' && message.list.items.length === 1);
    expect(state.list.items[0]).toMatchObject({ name: 'Milk', amount: '2 L' });
    const itemId = state.list.items[0].id as string;

    clientB.socket.send(JSON.stringify({ t: 'item:update', id: itemId, patch: { collected: true } }));
    expect((await waitFor(clientA.messages, (message) => message.t === 'state' && message.list.items[0]?.collected)).list.items[0].collected).toBe(true);

    clientB.socket.send('not json');
    clientB.socket.send(JSON.stringify({ t: 'ping' }));
    expect((await waitFor(clientB.messages, (message) => message.t === 'pong')).t).toBe('pong');

    clientA.socket.send(JSON.stringify({ t: 'list:delete', ownerToken: 'wrong' }));
    expect((await waitFor(clientA.messages, (message) => message.t === 'error')).message).toContain('Only');
    expect((await fetch(`${base}/api/lists/${created.list.id}`)).status).toBe(200);

    clientA.socket.send(JSON.stringify({ t: 'list:delete', ownerToken: created.ownerToken }));
    expect((await waitFor(clientB.messages, (message) => message.t === 'closed')).reason).toBe('deleted');
    expect((await fetch(`${base}/api/lists/${created.list.id}`)).status).toBe(404);
    await close(clientA.socket);
    await close(clientB.socket);
  });
});

type Message = Record<string, any>;
type Client = { socket: WebSocket; messages: Message[] };

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: Message[] = [];
    socket.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString()) as Message); } catch { /* ignore */ }
    });
    socket.once('error', reject);
    socket.once('open', () => resolve({ socket, messages }));
  });
}

async function waitFor(messages: Message[], predicate: (message: Message) => boolean): Promise<Message> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const index = messages.findIndex(predicate);
    if (index !== -1) return messages.splice(0, index + 1).pop() as Message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for message: ${messages.map((message) => message.t).join(', ')}`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', () => resolve());
    socket.close();
  });
}
