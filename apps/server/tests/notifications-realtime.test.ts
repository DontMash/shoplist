import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import type { TransportContract } from '@shoplist/transport-contract';
import { startServer, type RunningServer } from '../src/server.js';
import type { NotificationPayload, PushSender } from '../src/notifications.js';
import type { PushSubscription } from '../src/store.js';

const subscription: PushSubscription = {
  endpoint: 'https://push.example/subscription-a',
  keys: { p256dh: 'public-key', auth: 'auth-key' },
};

type RpcClient = ContractRouterClient<TransportContract>;

describe('realtime push notifications over the native transport', () => {
  let directory: string;
  let running: RunningServer;
  let wsBase: string;
  const send = vi.fn(async (_destination: unknown, _payload: NotificationPayload) => undefined);

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-realtime-'));
    await mkdir(path.join(directory, 'public'));
    await writeFile(path.join(directory, 'public', 'index.html'), '<!doctype html><title>Shoplist</title>');
    const pushSender: PushSender = { send };
    await new Promise<void>((resolve) => {
      running = startServer({
        host: '127.0.0.1',
        port: 0,
        dataFile: path.join(directory, 'db.sqlite'),
        publicDir: path.join(directory, 'public'),
        pushPublicKey: 'public-key',
        pushSender,
        notificationCoalesceMs: 0,
        onListening: (port) => {
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

  it('notifies an offline participant when someone joins', async () => {
    send.mockClear();
    const list = running.store.createList('Groceries');
    running.store.touchMember(list, 'alice', 'Alice', '#123456');
    running.store.registerPushDestination(list.id, 'alice', subscription);

    const bob = await connect(wsBase);
    await bob.client.listSession.open({ listId: list.id, clientId: 'bob', name: 'Bob', protocolVersion: 1 });
    await waitForCall(send, (call) => call[0]?.clientId === 'alice');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'alice' }), expect.objectContaining({
      body: 'Bob joined Groceries',
      url: `/#/list/${list.id}`,
    }));
    await bob.close();
  });

  it('does not push a join notification to participants with an active list session', async () => {
    send.mockClear();
    const list = running.store.createList('Active list');
    running.store.touchMember(list, 'alice', 'Alice', '#123456');
    running.store.registerPushDestination(list.id, 'alice', subscription);

    const alice = await connect(wsBase);
    await alice.client.listSession.open({ listId: list.id, clientId: 'alice', name: 'Alice', protocolVersion: 1 });
    const bob = await connect(wsBase);
    await bob.client.listSession.open({ listId: list.id, clientId: 'bob', name: 'Bob', protocolVersion: 1 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
    await alice.close();
    await bob.close();
  });

  it('sends a final deletion notification before closing the list room', async () => {
    send.mockClear();
    const list = running.store.createList('Deleted list');
    running.store.touchMember(list, 'alice', 'Alice', '#654321');
    running.store.touchMember(list, 'bob', 'Bob', '#123456');
    running.store.registerPushDestination(list.id, 'bob', { ...subscription, endpoint: 'https://push.example/delete' });

    const alice = await connect(wsBase);
    const opened = await alice.client.listSession.open({ listId: list.id, clientId: 'alice', name: 'Alice', protocolVersion: 1 });
    const ack = await alice.client.list.delete({
      listId: list.id,
      sessionId: opened.sessionId,
      clientId: 'alice',
      operationId: 'delete-list',
      ownerToken: list.ownerToken,
    });
    expect(ack).toMatchObject({ status: 'accepted' });

    await waitForCall(send, (call) => call[0]?.clientId === 'bob');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bob' }), expect.objectContaining({
      body: 'Alice deleted Deleted list',
    }));
    await alice.close();
  });

  it('routes accepted mutations to the injected push sender', async () => {
    send.mockClear();
    const list = running.store.createList('Mutation list');
    running.store.touchMember(list, 'alice', 'Alice', '#654321');
    running.store.touchMember(list, 'bob', 'Bob', '#123456');
    running.store.registerPushDestination(list.id, 'bob', { ...subscription, endpoint: 'https://push.example/bob' });

    const alice = await connect(wsBase);
    const opened = await alice.client.listSession.open({ listId: list.id, clientId: 'alice', name: 'Alice', protocolVersion: 1 });
    const ack = await alice.client.item.add({
      listId: list.id,
      sessionId: opened.sessionId,
      clientId: 'alice',
      operationId: 'add-item',
      name: 'Milk',
    });
    expect(ack).toMatchObject({ status: 'accepted' });

    await waitForCall(send, (call) => call[0]?.clientId === 'bob');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bob' }), expect.objectContaining({
      body: 'Alice updated Mutation list',
    }));
    await alice.close();
  });

  it('closes active websocket sessions during server shutdown', async () => {
    const list = running.store.createList('Shutdown list');
    const alice = await connect(wsBase);
    await alice.client.listSession.open({ listId: list.id, clientId: 'shutdown', name: 'Alice', protocolVersion: 1 });
    const closed = new Promise<void>((resolve) => alice.socket.once('close', () => resolve()));
    await running.close();
    await closed;
  });
});

interface ConnectedClient {
  socket: WebSocket;
  client: RpcClient;
  close: () => Promise<void>;
}

async function connect(base: string): Promise<ConnectedClient> {
  const socket = new WebSocket(`${base}/rpc`);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => resolve());
  });
  const client = createORPCClient<RpcClient>(new RPCLink({ websocket: socket as unknown as WebSocket }));
  return {
    socket,
    client,
    close: () => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve());
      socket.close();
    }),
  };
}

async function waitForCall(mock: ReturnType<typeof vi.fn>, predicate: (call: any[]) => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (mock.mock.calls.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for push delivery');
}
