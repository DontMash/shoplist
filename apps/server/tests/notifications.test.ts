import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { NotificationDispatcher, WebPushSender, notificationPayload, sendNotification, type NotificationEvent, type NotificationPayload } from '../src/notifications.js';
import { Store, type PushSubscription } from '../src/store.js';

const webPush = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('web-push', () => ({ default: webPush }));

const subscription: PushSubscription = {
  endpoint: 'https://push.example/subscription-a',
  keys: { p256dh: 'public-key', auth: 'auth-key' },
};

describe('web push sender', () => {
  it('configures VAPID and sends encrypted browser payloads through the adapter', async () => {
    const sender = new WebPushSender('public', 'private', 'mailto:admin@example.com');
    await sender.send({
      listId: 'list-1', clientId: 'alice', endpoint: subscription.endpoint,
      keys: subscription.keys, muted: false,
    }, { title: 'Shoplist', body: 'Bob joined Groceries', url: '/#/list/list-1', tag: 'shoplist-list-1' });
    expect(webPush.setVapidDetails).toHaveBeenCalledWith('mailto:admin@example.com', 'public', 'private');
    expect(webPush.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ endpoint: subscription.endpoint }), expect.stringContaining('Bob joined Groceries'));
  });
});

describe('notification payloads', () => {
  it('uses privacy-safe event text and opens the relevant list', () => {
    const common = { listId: 'weekend-list', listName: 'Weekend shopping', actorClientId: 'bob', actorName: 'Bob' };
    const cases: Array<[NotificationEvent, string]> = [
      [{ ...common, kind: 'join' }, 'Bob joined Weekend shopping'],
      [{ ...common, kind: 'changed' }, 'Bob updated Weekend shopping'],
      [{ ...common, kind: 'clear' }, 'Bob cleared Weekend shopping'],
      [{ ...common, kind: 'rename' }, 'Bob renamed Weekend shopping'],
      [{ ...common, kind: 'delete' }, 'Bob deleted Weekend shopping'],
    ];

    for (const [event, body] of cases) {
      expect(notificationPayload(event)).toEqual({
        title: 'Shoplist',
        body,
        url: '/#/list/weekend-list',
        tag: 'shoplist-weekend-list',
      });
    }
  });
});

describe('notification destinations', () => {
  const resources: Array<{ directory: string; store: Store }> = [];

  afterEach(async () => {
    for (const { directory, store } of resources.splice(0)) {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('manages notification subscriptions and membership through the OpenAPI transport', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-api-'));
    const resources = createApp({
      dataFile: path.join(directory, 'db.sqlite'),
      pushPublicKey: 'public-key',
      pushSender: { send: async () => undefined },
    });
    const list = resources.store.createList('Groceries');
    resources.store.touchMember(list, 'alice', 'Alice', '#123456');

    const call = async (pathname: string, body: unknown) => {
      const response = await resources.app.request(`http://shoplist.test/api${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    expect(await call('/push/config', {})).toMatchObject({ status: 200, body: { publicKey: 'public-key', available: true } });
    expect(await call('/push/status', { listId: list.id, clientId: 'alice' })).toMatchObject({
      status: 200, body: { enabled: false, muted: false, available: true },
    });
    expect((await call('/push/status', { listId: 'nope', clientId: 'alice' })).status).toBe(404);
    expect((await call('/push/register', {
      listId: list.id,
      clientId: 'alice',
      subscription: { endpoint: 'http://invalid.example/subscription', keys: subscription.keys },
    })).status).toBe(400);
    expect((await call('/push/register', { listId: list.id, clientId: 'nobody', subscription })).status).toBe(403);
    expect((await call('/push/mute', { listId: list.id, clientId: 'alice', muted: true })).status).toBe(404);
    expect((await call('/push/mute', { listId: list.id, clientId: 'alice', muted: 'yes' })).status).toBe(400);

    expect(await call('/push/register', { listId: list.id, clientId: 'alice', subscription })).toMatchObject({
      status: 200,
      body: { enabled: true, muted: false, available: true },
    });
    expect(await call('/push/mute', { listId: list.id, clientId: 'alice', muted: true })).toMatchObject({
      status: 200,
      body: { enabled: true, muted: true },
    });
    expect(await call('/push/remove', { listId: list.id, clientId: 'alice' })).toMatchObject({
      status: 200,
      body: { enabled: false, muted: false },
    });

    expect((await call('/list/leave', { listId: list.id })).status).toBe(400);
    expect(await call('/list/leave', { listId: list.id, clientId: 'alice' })).toMatchObject({
      status: 200,
      body: { left: true },
    });

    resources.store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('tracks active joins, leaves, re-joins, and per-list push destinations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notifications-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    resources.push({ directory, store });
    const list = store.createList('Groceries');

    expect(store.touchMember(list, 'alice', 'Alice', '#123456')).toMatchObject({ joined: true });
    expect(store.touchMember(list, 'alice', 'Alice', '#123456')).toMatchObject({ joined: false });
    expect(store.touchMember(list, 'bob', 'Bob', '#654321')).toMatchObject({ joined: true });

    expect(store.getNotificationStatus(list.id, 'alice')).toEqual({ enabled: false, muted: false });
    expect(store.registerPushDestination(list.id, 'alice', subscription)).toBe(true);
    expect(store.getNotificationStatus(list.id, 'alice')).toEqual({ enabled: true, muted: false });
    expect(store.getNotificationRecipients(list.id, new Set(['bob']))).toEqual([
      expect.objectContaining({ clientId: 'alice', endpoint: subscription.endpoint }),
    ]);

    expect(store.setNotificationsMuted(list.id, 'alice', true)).toBe(true);
    expect(store.getNotificationStatus(list.id, 'alice')).toEqual({ enabled: true, muted: true });
    expect(store.getNotificationRecipients(list.id, new Set())).toEqual([]);

    expect(store.leaveMember(list.id, 'alice')).toBe(true);
    expect(store.touchMember(list, 'alice', 'Alice again', '#123456')).toMatchObject({ joined: true });
    expect(store.getNotificationStatus(list.id, 'alice')).toEqual({ enabled: true, muted: true });
    expect(store.setNotificationsMuted(list.id, 'alice', false)).toBe(true);
    expect(store.getNotificationRecipients(list.id, new Set())).toEqual([
      expect.objectContaining({ clientId: 'alice', endpoint: subscription.endpoint }),
    ]);
  });

  it('delivers notifications and prunes expired destinations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-delivery-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    resources.push({ directory, store });
    const list = store.createList('Groceries');
    store.touchMember(list, 'alice', 'Alice', '#123456');
    store.touchMember(list, 'bob', 'Bob', '#654321');
    store.registerPushDestination(list.id, 'alice', subscription);
    store.registerPushDestination(list.id, 'bob', { ...subscription, endpoint: 'https://push.example/subscription-b' });
    store.touchMember(list, 'carol', 'Carol', '#abcdef');
    store.registerPushDestination(list.id, 'carol', { ...subscription, endpoint: 'https://push.example/subscription-c' });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async (destination: { clientId: string }) => {
      if (destination.clientId === 'alice') {
        const error = Object.assign(new Error('gone'), { statusCode: 410 });
        throw error;
      }
      if (destination.clientId === 'carol') throw new Error('temporary failure');
    });

    await sendNotification(store, { send }, {

      listId: list.id, listName: list.name, actorClientId: 'dave', actorName: 'Dave', kind: 'join',
    }, new Set(['bob']));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([destination]) => destination.clientId)).toEqual(expect.arrayContaining(['alice', 'carol']));
    expect(store.getNotificationStatus(list.id, 'alice')).toEqual({ enabled: false, muted: false });
    expect(errorLog).toHaveBeenCalledWith('[push] delivery failed:', 'temporary failure');
    errorLog.mockRestore();
  });

  it('coalesces rapid changes into one notification', async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-coalesce-'));
      const store = new Store(path.join(directory, 'db.sqlite'));
      resources.push({ directory, store });
      const list = store.createList('Groceries');
      store.touchMember(list, 'alice', 'Alice', '#123456');
      store.registerPushDestination(list.id, 'alice', subscription);
      const send = vi.fn(async (_destination: PushSubscription, _payload: NotificationPayload) => undefined);
      const dispatcher = new NotificationDispatcher(store, { send }, () => new Set(), { coalesceMs: 100 });

      void dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'bob', actorName: 'Bob', kind: 'changed' });
      void dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'carol', actorName: 'Carol', kind: 'changed' });
      await vi.advanceTimersByTimeAsync(100);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toMatchObject({ body: 'Several people updated Groceries' });
      dispatcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pending mutation notification when a join arrives', async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-join-'));
      const store = new Store(path.join(directory, 'db.sqlite'));
      resources.push({ directory, store });
      const list = store.createList('Groceries');
      store.touchMember(list, 'alice', 'Alice', '#123456');
      store.registerPushDestination(list.id, 'alice', subscription);
      const send = vi.fn(async (_destination: PushSubscription, _payload: NotificationPayload) => undefined);
      const dispatcher = new NotificationDispatcher(store, { send }, () => new Set(), { coalesceMs: 100 });

      void dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'bob', actorName: 'Bob', kind: 'changed' });
      await dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'carol', actorName: 'Carol', kind: 'join' });
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.map(([, payload]) => payload.body)).toEqual(expect.arrayContaining([
        'Carol joined Groceries', 'Bob updated Groceries',
      ]));
      dispatcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending mutation notification when a deletion arrives', async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-delete-'));
      const store = new Store(path.join(directory, 'db.sqlite'));
      resources.push({ directory, store });
      const list = store.createList('Groceries');
      store.touchMember(list, 'alice', 'Alice', '#123456');
      store.registerPushDestination(list.id, 'alice', subscription);
      const send = vi.fn(async (_destination: PushSubscription, _payload: NotificationPayload) => undefined);
      const dispatcher = new NotificationDispatcher(store, { send }, () => new Set(), { coalesceMs: 100 });

      void dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'bob', actorName: 'Bob', kind: 'changed' });
      await dispatcher.dispatch({ listId: list.id, listName: list.name, actorClientId: 'bob', actorName: 'Bob', kind: 'delete' });
      await vi.advanceTimersByTimeAsync(100);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toMatchObject({ body: 'Bob deleted Groceries' });
      dispatcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes only accepted mutations for downstream delivery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-notification-events-'));
    const store = new Store(path.join(directory, 'db.sqlite'));
    resources.push({ directory, store });
    const list = store.createList('Groceries');

    const rejected = store.applyOperation(list.id, {
      operationId: 'rejected', kind: 'list:rename', actorClientId: 'bob', actorName: 'Bob', payload: { name: ' ' },
    });
    expect(rejected.notification).toBeUndefined();

    const accepted = store.applyOperation(list.id, {
      operationId: 'accepted', kind: 'list:rename', actorClientId: 'bob', actorName: 'Bob', payload: { name: 'Weekend shopping' },
    });
    expect(accepted.notification).toEqual({
      listId: list.id,
      listName: 'Weekend shopping',
      actorClientId: 'bob',
      actorName: 'Bob',
      kind: 'rename',
    });
  });
});
