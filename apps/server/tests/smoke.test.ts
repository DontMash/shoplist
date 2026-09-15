import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import SQLiteDatabase from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  createApp,
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
      name: 'Milk', amount: '2 L', collected: false, by: 'client-a', lastEditedBy: 'client-a',
    });
    expect(store.addItem(list, { name: '  ' }, 'client-a')).toBeNull();
    const item = list.items[0];
    expect(store.updateItem(list, item.id, { collected: true, amount: '3 L' }, 'client-b')).toBe(true);
    expect(item).toMatchObject({ collected: true, amount: '3 L', lastEditedBy: 'client-b' });
    expect(store.updateItem(list, item.id, { name: ' ' })).toBe(false);
    expect(store.deleteItem(list, item.id)).toBe(true);
    expect(store.deleteItem(list, item.id)).toBe(false);
    expect(store.deleteList(list.id)).toBe(true);
    expect(store.getList(list.id)).toBeNull();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('leaves the last editor unchanged for actorless compatibility updates', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-actorless-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    const list = store.createList('Actorless updates');
    const item = store.addItem(list, { name: 'Milk' }, 'client-a')!;
    const result = store.applyOperation(list.id, {
      operationId: 'actorless-update', kind: 'item:update', actorClientId: null,
      payload: { id: item.id, patch: { collected: true } },
    });
    expect(result.ack.status).toBe('accepted');
    expect(list.items[0]).toMatchObject({ collected: true, lastEditedBy: 'client-a' });
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
    expect(store.getList(list.id)?.items[0]).toMatchObject({ lastEditedBy: 'client-a' });
    expect(store.applyOperation(list.id, {
      operationId: 'op-reject', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { name: ' ' } },
    }).ack).toMatchObject({ status: 'rejected', reason: 'name-required', reasonCode: 'name-required', revision: 2 });
    expect(store.getList(list.id)?.revision).toBe(2);
    expect(store.applyOperation(list.id, {
      operationId: 'op-empty-patch', kind: 'item:update', actorClientId: 'client-a', payload: { id: itemId, patch: {} },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-add-name', kind: 'item:add', actorClientId: 'client-a', payload: { name: 2 },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-add-amount', kind: 'item:add', actorClientId: 'client-a', payload: { name: 'Bad', amount: 2 },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-update-name', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { name: 2 } },
    }).ack).toMatchObject({ status: 'rejected', reason: 'invalid-payload', revision: 2 });
    expect(store.applyOperation(list.id, {
      operationId: 'op-bad-update-amount', kind: 'item:update', actorClientId: 'client-a',
      payload: { id: itemId, patch: { amount: 2 } },
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
    expect(item).toMatchObject({ name: 'Whole-grain bread', amount: '1 loaf', collected: true, lastEditedBy: null });
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

  it('migrates an existing SQLite database from the pre-journal schema', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-sqlite-migration-'));
    const file = path.join(directory, 'db.sqlite');
    const sqlite = new SQLiteDatabase(file);
    sqlite.exec(await readFile(new URL('./fixtures/pre-journal.sql', import.meta.url), 'utf8'));
    sqlite.close();

    const store = new Store(file);
    expect(store.getList('legacy')?.items[0]).toMatchObject({ name: 'Bread', by: 'client-a', lastEditedBy: null });
    expect(store.getList('legacy')?.members['client-a']).toMatchObject({ name: 'Alice', leftAt: null });
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('recognizes the supported pre-journal schema versions', () => {
    const infer = (catalog: Array<{ name: string; sql: string | null }>): number =>
      (Store.prototype as any).inferMigrationCount(catalog, snapshots);
    const snapshot = (tables: Record<string, string[]>) => ({
      tables: Object.fromEntries(Object.entries(tables).map(([name, columns]) => [
        name, { columns: Object.fromEntries(columns.map((column) => [column, {}])) },
      ])),
    });
    const snapshots = [
      snapshot({ lists: ['id'], items: ['id'], members: ['id'] }),
      snapshot({ lists: ['id', 'revision'], items: ['id'], members: ['id'], processed_operations: ['operation_id'] }),
      snapshot({ lists: ['id', 'revision'], items: ['id', 'last_edited_by'], members: ['id'], processed_operations: ['operation_id'] }),
      snapshot({
        lists: ['id', 'revision'], items: ['id', 'last_edited_by'], members: ['id', 'left_at'],
        processed_operations: ['operation_id'], push_destinations: ['id'],
      }),
      snapshot({
        lists: ['id', 'revision'], items: ['id', 'last_edited_by'], members: ['id', 'left_at'],
        processed_operations: ['operation_id', 'payload_hash'], push_destinations: ['id'],
      }),
    ];
    const catalog = (overrides: Record<string, string | null> = {}) => [
      { name: 'lists', sql: overrides.lists ?? 'id' },
      { name: 'items', sql: overrides.items ?? 'id' },
      { name: 'members', sql: overrides.members ?? 'id' },
      ...Object.entries(overrides)
        .filter(([name]) => !['lists', 'items', 'members'].includes(name))
        .map(([name, sql]) => ({ name, sql })),
    ];

    expect(infer(catalog())).toBe(1);
    expect(infer(catalog({ processed_operations: 'operation_id', lists: 'id revision' }))).toBe(2);
    expect(infer(catalog({
      processed_operations: 'operation_id', lists: 'id revision', items: 'id last_edited_by',
    }))).toBe(3);
    expect(infer(catalog({
      processed_operations: 'operation_id', lists: 'id revision', items: 'id last_edited_by',
      members: 'id left_at', push_destinations: 'id',
    }))).toBe(4);
    expect(infer(catalog({
      processed_operations: 'operation_id payload_hash', lists: 'id revision', items: 'id last_edited_by',
      members: 'id left_at', push_destinations: 'id',
    }))).toBe(5);
    expect(infer(catalog({
      processed_operations: 'operation_id', lists: 'id revision', items: 'id last_edited_by',
      push_destinations: 'id',
    }))).toBe(3);
    expect(() => infer([{ name: 'lists', sql: 'id' }])).toThrow('does not match');
    expect(() => infer(catalog({ processed_operations: 'operation_id', lists: 'id', items: '' }))).toThrow('does not match');
  });

  it('reports a failed WAL checkpoint without masking shutdown', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-checkpoint-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    const checkpointError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (store as any).sqlite.close();
    store.flushSync();
    expect(checkpointError).toHaveBeenCalledWith('[store] checkpoint failed:', expect.any(String));
    checkpointError.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });
});


describe('server helpers', () => {
  it('validates browser origins and proxy forwarding', () => {
    const request = new Request('http://example.test/healthz', { headers: { host: 'example.test' } });
    expect(sameOrigin(request)).toBe(true);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'http://example.test' } }))).toBe(true);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'https://evil.example' } }))).toBe(false);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'https://example.test' } }))).toBe(false);
    expect(sameOrigin(new Request('http://internal.example/rpc', {
      headers: { host: 'example.test', origin: 'https://example.test', upgrade: 'websocket' },
    }))).toBe(true);
    expect(sameOrigin(new Request('http://internal.example/rpc', {
      headers: { host: 'internal.example', origin: 'http://example.test', upgrade: 'websocket' },
    }))).toBe(false);
    expect(sameOrigin(new Request('http://internal.example/rpc', {
      headers: { host: 'example.test', origin: 'https://evil.example', upgrade: 'websocket' },
    }))).toBe(false);
    expect(sameOrigin(new Request('http://internal.example/rpc', {
      headers: { host: 'internal.example', origin: 'https://shoplist.example', upgrade: 'websocket' },
    }), 'https://shoplist.example')).toBe(true);
    expect(sameOrigin(new Request('http://internal.example/rpc', {
      headers: { host: 'internal.example', origin: 'https://evil.example', upgrade: 'websocket' },
    }), 'https://shoplist.example')).toBe(false);
    expect(sameOrigin(new Request(request, { headers: { host: 'example.test', origin: 'not-a-url' } }))).toBe(false);
    expect(sameOrigin(new Request('http://internal.example/healthz', {
      headers: { host: 'internal.example', origin: 'https://shoplist.example', 'x-forwarded-host': 'shoplist.example', 'x-forwarded-proto': 'https' },
    }))).toBe(true);
    expect(sameOrigin(new Request('http://internal.example/healthz', {
      headers: { host: 'internal.example', origin: 'https://shoplist.example', 'x-forwarded-host': 'shoplist.example', 'x-forwarded-proto': 'ftp' },
    }))).toBe(false);
  });
});

describe('Hono application and native realtime boundaries', () => {
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
        buildId: 'test-build',
        dataFile: path.join(directory, 'db.sqlite'),
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

  it('uses default app paths and turns unhandled failures into safe errors', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-defaults-'));
    const previousDataDir = process.env.DATA_DIR;
    const previousPublicDir = process.env.PUBLIC_DIR;
    process.env.DATA_DIR = dataDirectory;
    delete process.env.PUBLIC_DIR;
    const resources = createApp();
    expect((await resources.app.request('/healthz')).status).toBe(200);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(resources.store, 'listCount').mockImplementation(() => {
      throw new Error('test failure');
    });
    const response = await resources.app.request('/healthz');
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

  it('serves health, the frontend shell, and the OpenAPI transport', async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(health.headers.get('strict-transport-security')).toBeNull();
    expect(health.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(health.headers.get('cross-origin-resource-policy')).toBeNull();
    expect(health.headers.get('x-xss-protection')).toBeNull();
    expect(health.headers.get('x-shoplist-build')).toBe('test-build');
    expect(await health.json()).toMatchObject({ ok: true, lists: 0, build: 'test-build' });

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>Shoplist</title>');
    expect((await fetch(`${base}/..%2f..%2fserver.js`)).status).toBeGreaterThanOrEqual(400);

    // Documentation and the generated specification are public read-only
    // routes; procedure calls retain the origin rejection below.
    expect((await fetch(`${base}/api/openapi.json`, {
      headers: { origin: 'https://evil.example' },
    })).status).toBe(200);

    // Removed legacy routes fail explicitly instead of serving the frontend shell.
    const legacy = await fetch(`${base}/api/lists`);
    expect(legacy.status).toBe(404);
    expect(await legacy.json()).toEqual({ error: 'procedure not found' });
    expect((await fetch(`${base}/api/qr?data=invite`)).status).toBe(404);

    // The OpenAPI surface keeps the same origin policy as the native transport.
    expect((await fetch(`${base}/api/list/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Rejected' }),
    })).status).toBe(403);
    expect((await fetch(`${base}/rpc`, {
      headers: { origin: 'https://evil.example' },
    })).status).toBe(403);
    const forwardedCreate = await fetch(`${base}/api/list/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://shoplist.example',
        'x-forwarded-host': 'shoplist.example',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ name: 'Forwarded list' }),
    });
    expect(forwardedCreate.status).toBe(201);
    const created = await forwardedCreate.json() as { list: { id: string; name: string }; ownerToken: string };
    expect(created.list.name).toBe('Forwarded list');
    expect(created.ownerToken).toHaveLength(16);

    const fetched = await fetch(`${base}/api/list/get?id=${encodeURIComponent(created.list.id)}`, {
      method: 'GET',
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ list: { id: created.list.id }, items: [], members: [], memberCount: 0 });
    expect((await fetch(`${base}/api/list/get?id=missing-list`, {
      method: 'GET',
    })).status).toBe(404);
    expect((await fetch(`${base}/api/unknown`, { method: 'POST' })).status).toBe(404);

    expect((await fetch(`${base}/favicon.ico`, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${base}/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/does-not-exist`, { method: 'POST' })).status).toBe(405);
  });

  it('accepts forwarded websocket origins for the native transport', async () => {
    const created = await (await fetch(`${base}/api/list/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Forwarded websocket' }),
    })).json() as { list: { id: string } };
    expect(created.list.id).toBeTruthy();

    const socket = new WebSocket(`${wsBase}/rpc`, {
      headers: { Host: 'shoplist.example', Origin: 'https://shoplist.example' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await close(socket);
  });
});

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', () => resolve());
    socket.close();
  });
}
