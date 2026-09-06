import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server.js';
import type { NotificationPayload, PushSender } from '../src/notifications.js';
import type { PushSubscription } from '../src/store.js';

const subscription: PushSubscription = {
  endpoint: 'https://push.example/subscription-a',
  keys: { p256dh: 'public-key', auth: 'auth-key' },
};

describe('realtime push notifications', () => {
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

    const bob = await connect(`${wsBase}/ws?list=${list.id}&client=bob&name=Bob`);
    await waitFor(bob.messages, (message) => message.t === 'init');
    await waitForCall(send, (call) => call[0]?.clientId === 'alice');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'alice' }), expect.objectContaining({
      body: 'Bob joined Groceries',
      url: `/#/list/${list.id}`,
    }));
    await close(bob.socket);
  });

  it('does not push a join notification to participants with an active list session', async () => {
    send.mockClear();
    const list = running.store.createList('Active list');
    running.store.touchMember(list, 'alice', 'Alice', '#123456');
    running.store.registerPushDestination(list.id, 'alice', subscription);
    const alice = await connect(`${wsBase}/ws?list=${list.id}&client=alice&name=Alice`);
    await waitFor(alice.messages, (message) => message.t === 'init');

    const bob = await connect(`${wsBase}/ws?list=${list.id}&client=bob&name=Bob`);
    await waitFor(bob.messages, (message) => message.t === 'init');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
    await close(alice.socket);
    await close(bob.socket);
  });

  it('sends a final deletion notification before closing the list room', async () => {
    send.mockClear();
    const list = running.store.createList('Deleted list');
    running.store.touchMember(list, 'alice', 'Alice', '#654321');
    running.store.touchMember(list, 'bob', 'Bob', '#123456');
    running.store.registerPushDestination(list.id, 'bob', { ...subscription, endpoint: 'https://push.example/delete' });
    const alice = await connect(`${wsBase}/ws?list=${list.id}&client=alice&name=Alice`);
    await waitFor(alice.messages, (message) => message.t === 'init');

    alice.socket.send(JSON.stringify({ t: 'list:delete', opId: 'delete-list', ownerToken: list.ownerToken }));
    await waitFor(alice.messages, (message) => message.t === 'ack' && message.opId === 'delete-list');
    await waitForCall(send, (call) => call[0]?.clientId === 'bob');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bob' }), expect.objectContaining({
      body: 'Alice deleted Deleted list',
    }));
    await close(alice.socket);
  });

  it('routes accepted mutations to the injected push sender', async () => {
    send.mockClear();
    const list = running.store.createList('Mutation list');
    running.store.touchMember(list, 'alice', 'Alice', '#654321');
    running.store.touchMember(list, 'bob', 'Bob', '#123456');
    running.store.registerPushDestination(list.id, 'bob', { ...subscription, endpoint: 'https://push.example/bob' });
    const alice = await connect(`${wsBase}/ws?list=${list.id}&client=alice&name=Alice`);
    await waitFor(alice.messages, (message) => message.t === 'init');

    alice.socket.send(JSON.stringify({ t: 'item:add', opId: 'add-item', item: { name: 'Milk' } }));
    await waitFor(alice.messages, (message) => message.t === 'ack' && message.opId === 'add-item');
    await waitForCall(send, (call) => call[0]?.clientId === 'bob');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bob' }), expect.objectContaining({
      body: 'Alice updated Mutation list',
    }));
    await close(alice.socket);
  });

  it('closes active sockets during server shutdown', async () => {
    const list = running.store.createList('Shutdown list');
    const alice = await connect(`${wsBase}/ws?list=${list.id}&client=shutdown&name=Alice`);
    await waitFor(alice.messages, (message) => message.t === 'init');
    await running.close();
    await close(alice.socket);
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

async function waitForCall(mock: ReturnType<typeof vi.fn>, predicate: (call: any[]) => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (mock.mock.calls.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for push delivery');
}

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', () => resolve());
    socket.close();
  });
}
