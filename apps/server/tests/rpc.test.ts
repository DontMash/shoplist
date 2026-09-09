import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, type ShoplistApp } from '../src/server.js';
import { createRouterClient } from '@orpc/server';
import { RpcEventPublisher, RpcSessionRegistry, createRpcRouter, publishPresence } from '../src/rpc.js';

const tempDirectories: string[] = [];
const apps: ShoplistApp[] = [];

afterEach(async () => {
  while (apps.length) apps.pop()?.store.close();
  while (tempDirectories.length) await rm(tempDirectories.pop()!, { recursive: true, force: true });
});

async function resource(options: Record<string, unknown> = {}): Promise<ShoplistApp> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-rpc-'));
  tempDirectories.push(directory);
  const resources = createApp({ dataFile: path.join(directory, 'db.sqlite'), ...options } as never);
  apps.push(resources);
  return resources;
}

async function rpc<T>(resources: ShoplistApp, pathName: string, input: unknown): Promise<T> {
  const response = await resources.app.request(`http://shoplist.test/rpc${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const body = await response.json() as { json?: T };
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body.json as T;
}

function pushSender() {
  return { send: async () => undefined };
}

describe('oRPC transport boundary', () => {
  it('serves typed list management and push procedures over one HTTP route', async () => {
    const resources = await resource({ pushPublicKey: 'public-key', pushSender: pushSender() });
    const created = await rpc<{ list: { id: string }; ownerToken: string }>(resources, '/list/create', { name: 'Groceries' });
    const listId = created.list.id;
    expect(created.ownerToken).toBeTruthy();

    await expect(rpc(resources, '/list/get', { id: 'missing-list' })).rejects.toThrow('404');
    expect(await rpc(resources, '/list/get', { id: listId })).toMatchObject({ list: { id: listId, revision: 0 }, items: [], members: [] });
    await expect(rpc(resources, '/listSession/open', {
      listId, clientId: '\u0000', name: 'Invalid', protocolVersion: 1,
    })).rejects.toThrow('400');
    const guest = await rpc<{ you: { name: string } }>(resources, '/listSession/open', {
      listId, clientId: 'guest', name: '   ', protocolVersion: 1,
    });
    expect(guest.you.name).toBe('Guest');
    expect(await rpc(resources, '/push/config', {})).toEqual({ publicKey: 'public-key', available: true });
    expect(await rpc(resources, '/push/status', { listId, clientId: 'client-a' })).toMatchObject({ enabled: false, muted: false, available: true });

    const opened = await rpc<{ sessionId: string }>(resources, '/listSession/open', {
      listId, clientId: 'client-a', name: 'Alice', protocolVersion: 1,
    });
    const subscription = {
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'public', auth: 'auth' },
    };
    expect(await rpc(resources, '/push/register', { listId, clientId: 'client-a', subscription })).toMatchObject({ enabled: true, muted: false });
    expect(await rpc(resources, '/push/mute', { listId, clientId: 'client-a', muted: true })).toMatchObject({ enabled: true, muted: true });
    expect(await rpc(resources, '/push/remove', { listId, clientId: 'client-a' })).toMatchObject({ enabled: false, muted: false });
    await expect(rpc(resources, '/push/mute', { listId, clientId: 'client-a', muted: true })).rejects.toThrow('404');
    expect(await rpc(resources, '/list/leave', { listId, clientId: 'client-a' })).toEqual({ left: true });
    await expect(rpc(resources, '/push/register', { listId, clientId: 'client-a', subscription })).rejects.toThrow('403');
    expect(opened.sessionId).toBeTruthy();
    await expect(rpc(resources, '/item/add', {
      listId, sessionId: 'missing-session', clientId: 'client-a', operationId: 'invalid-session', name: 'Milk',
    })).rejects.toThrow('403');

    const qr = await rpc<{ svg: string }>(resources, '/qr/generate', { data: 'https://shoplist.test/#/join/list' });
    expect(qr.svg).toContain('<svg');
  });

  it('opens a session, reconciles item.add, and preserves operation identity', async () => {
    const resources = await resource();
    const created = await rpc<{ list: { id: string }; ownerToken: string }>(resources, '/list/create', { name: 'Realtime' });
    const input = { listId: created.list.id, clientId: 'client-a', name: 'Alice', protocolVersion: 1 };
    const opened = await rpc<{ sessionId: string; eventCursor: string }>(resources, '/listSession/open', input);
    const queue = resources.rpcPublisher.subscribe(created.list.id, opened.eventCursor);
    const mutation = {
      listId: created.list.id, sessionId: opened.sessionId, clientId: 'client-a',
      operationId: 'operation-add', name: 'Milk', amount: '2 L', tempItemId: 'temp:operation-add',
    };
    const ack = await rpc<{ status: string; revision: number; itemId: string }>(resources, '/item/add', mutation);
    expect(ack).toMatchObject({ status: 'accepted', revision: 1 });
    expect(ack.itemId).toBeTruthy();
    expect((await queue.next()).value).toMatchObject({ kind: 'state', snapshot: { list: { revision: 1 } } });

    const duplicate = await rpc(resources, '/item/add', mutation);
    expect(duplicate).toMatchObject({ status: 'accepted', revision: 1 });
    const reused = await rpc(resources, '/item/add', { ...mutation, name: 'Bread' });
    expect(reused).toMatchObject({ status: 'rejected', reason: 'operation-id-reused', revision: 1 });

    const itemId = ack.itemId;
    expect(await rpc(resources, '/item/update', {
      ...mutation, operationId: 'operation-update', id: itemId, patch: { collected: true },
    })).toMatchObject({ status: 'accepted', revision: 2 });
    expect(await rpc(resources, '/item/delete', {
      ...mutation, operationId: 'operation-delete', id: itemId,
    })).toMatchObject({ status: 'accepted', revision: 3 });
    const rejected = await rpc(resources, '/item/add', {
      ...mutation, operationId: 'operation-reject', name: '   ', amount: '', tempItemId: 'temp-reject',
    });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'name-required', revision: 3 });

    await queue.return();
  });

  it('keeps presence independent and closes sessions after terminal deletion', async () => {
    const resources = await resource();
    publishPresence({ store: resources.store, publisher: resources.rpcPublisher, sessions: resources.rpcSessions } as never, 'missing-list');
    const created = await rpc<{ list: { id: string }; ownerToken: string }>(resources, '/list/create', { name: 'Shared' });
    const first = await rpc<{ sessionId: string }>(resources, '/listSession/open', {
      listId: created.list.id, clientId: 'a', name: 'Alice', protocolVersion: 1,
    });
    const queue = resources.rpcPublisher.subscribe(created.list.id);
    const router = createRpcRouter({
      store: resources.store,
      publisher: resources.rpcPublisher,
      sessions: resources.rpcSessions,
      dispatcher: resources.dispatcher,
      publicKey: '',
    });
    const sessionClient = createRouterClient(router);
    const eventIterator = await sessionClient.listSession.events({ listId: created.list.id, sessionId: first.sessionId });
    const eventReady = eventIterator.next();
    await rpc(resources, '/listSession/open', {
      listId: created.list.id, clientId: 'b', name: 'Bob', protocolVersion: 1,
    });
    const presence = (await queue.next()).value as { kind: string; online: Array<{ clientId: string }> };
    expect(presence.kind).toBe('presence');
    expect(presence.online.map((participant) => participant.clientId)).toEqual(expect.arrayContaining(['a', 'b']));
    expect((await eventReady).value).toMatchObject({ kind: 'presence' });
    expect(resources.rpcSessions.online(created.list.id)).toHaveLength(2);
    expect(resources.rpcSessions.get(first.sessionId)?.clientId).toBe('a');

    await rpc(resources, '/item/add', {
      listId: created.list.id, sessionId: first.sessionId, clientId: 'a', operationId: 'pre-delete', name: 'Bread',
    });
    await rpc(resources, '/list/clear', {
      listId: created.list.id, sessionId: first.sessionId, clientId: 'a', operationId: 'clear',
    });
    await rpc(resources, '/list/rename', {
      listId: created.list.id, sessionId: first.sessionId, clientId: 'a', operationId: 'rename', name: 'Renamed',
    });
    for (let index = 0; index < 3; index += 1) await queue.next();
    const denied = await rpc(resources, '/list/delete', {
      listId: created.list.id, sessionId: first.sessionId, clientId: 'a', operationId: 'denied', ownerToken: 'wrong',
    });
    expect(denied).toMatchObject({ status: 'rejected', reason: 'not-owner', revision: 3 });
    const deleted = await rpc(resources, '/list/delete', {
      listId: created.list.id, sessionId: first.sessionId, clientId: 'a', operationId: 'delete', ownerToken: created.ownerToken,
    });
    expect(deleted).toMatchObject({ status: 'accepted', revision: 4 });
    expect((await queue.next()).value).toMatchObject({ kind: 'list-closed', reason: 'deleted' });
    expect((await queue.next()).done).toBe(true);
    const remainingEvents: unknown[] = [];
    for await (const event of eventIterator) remainingEvents.push(event);
    expect(remainingEvents).toHaveLength(4);
    expect(resources.rpcSessions.online(created.list.id)).toEqual([]);
  });

  it('maps synchronous persistence failures to a safe typed error', async () => {
    const resources = await resource();
    const created = await rpc<{ list: { id: string } }>(resources, '/list/create', { name: 'Unavailable' });
    const opened = await rpc<{ sessionId: string }>(resources, '/listSession/open', {
      listId: created.list.id, clientId: 'a', name: 'Alice', protocolVersion: 1,
    });
    vi.spyOn(resources.store, 'applyOperation').mockImplementation(() => {
      throw 'database details';
    });
    const response = await resources.app.request('http://shoplist.test/rpc/item/add', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: {
        listId: created.list.id, sessionId: opened.sessionId, clientId: 'a', operationId: 'db-error', name: 'Milk',
      } }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ json: { code: 'INTERNAL_SERVER_ERROR', message: 'The list is temporarily unavailable.' } });
  });

  it('returns an explicit upgrade-required failure rather than starting an endless retry', async () => {
    const resources = await resource();
    const created = await rpc<{ list: { id: string } }>(resources, '/list/create', { name: 'Versioned' });
    const response = await resources.app.request('http://shoplist.test/rpc/listSession/open', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { listId: created.list.id, clientId: 'a', name: 'A', protocolVersion: 999 } }),
    });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ json: { code: 'UPGRADE_REQUIRED' } });
  });
});

describe('process-local oRPC publisher and session registry', () => {
  it('delivers cursored events and releases queues and sessions', async () => {
    const publisher = new RpcEventPublisher();
    const queue = publisher.subscribe('list');
    const pending = queue.next();
    expect(publisher.cursor('list')).toBe('0');
    expect(publisher.publish('no-subscriber', { kind: 'presence', protocolVersion: 1, online: [], members: [] })).toBe('1');
    expect(publisher.publish('list', { kind: 'presence', protocolVersion: 1, online: [], members: [] })).toBe('1');
    expect((await pending).value).toMatchObject({ eventCursor: '1', kind: 'presence' });
    const replay = publisher.subscribe('list', '0');
    expect((await replay.next()).value).toMatchObject({ eventCursor: '1' });
    for (let index = 0; index < 101; index += 1) {
      publisher.publish('history', { kind: 'presence', protocolVersion: 1, online: [], members: [] });
    }
    const bounded = publisher.subscribe('history', '0');
    expect((await bounded.next()).value).toMatchObject({ eventCursor: '2' });
    const invalidCursor = publisher.subscribe('history', 'not-a-cursor');
    expect((await invalidCursor.return()).done).toBe(true);
    publisher.unsubscribe('list', queue);
    publisher.close('list');
    expect((await queue.return()).done).toBe(true);
    expect((await replay.return()).done).toBe(true);
    const otherQueue = publisher.subscribe('other-list');
    const otherPending = otherQueue.next();
    publisher.closeAll();
    expect((await otherPending).done).toBe(true);

    const sessions = new RpcSessionRegistry();
    const one = sessions.open('list', 'client-a', 'Alice');
    const two = sessions.open('list', 'list-client', 'Bob');
    sessions.open('list', 'client-a', 'Alice again');
    expect(sessions.online('list')).toHaveLength(2);
    expect(sessions.onlineClientIds('list')).toEqual(new Set(['client-a', 'list-client']));
    expect(sessions.close(two.sessionId)?.clientId).toBe('list-client');
    expect(sessions.close('missing-session')).toBeUndefined();
    expect(sessions.get(one.sessionId)?.name).toBe('Alice');
    expect(sessions.closeList('list')).toHaveLength(2);
    sessions.open('other-list', 'other-client', 'Other');
    expect(sessions.closeList('list')).toEqual([]);
    sessions.closeAll();
    expect(sessions.online('list')).toEqual([]);
    expect(sessions.online('other-list')).toEqual([]);
  });
});
