import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import type { TransportContract } from '@shoplist/transport-contract';
import { startServer, type RunningServer } from '../src/server.js';

const runningServers: RunningServer[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  while (sockets.length) {
    const socket = sockets.pop()!;
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }
  while (runningServers.length) await runningServers.pop()!.close();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});

async function startRealtimeServer(): Promise<number> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-rpc-ws-'));
  directories.push(directory);
  let port = 0;
  await new Promise<void>((resolve) => {
    const server = startServer({
      port: 0,
      host: '127.0.0.1',
      dataFile: path.join(directory, 'db.sqlite'),
      publicDir: directory,
      onListening: (value) => { port = value; resolve(); },
    });
    runningServers.push(server);
  });
  return port;
}

async function connect(port: number): Promise<ContractRouterClient<TransportContract>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return createORPCClient<ContractRouterClient<TransportContract>>(
    new RPCLink({ websocket: socket as unknown as WebSocket }),
  );
}

describe('public /rpc WebSocket seam', () => {
  it('opens a list session, accepts item.add, and emits its full-state event', async () => {
    const port = await startRealtimeServer();
    const client = await connect(port);
    const created = await client.list.create({ name: 'WebSocket list' });
    const opened = await client.listSession.open({
      listId: created.list.id,
      clientId: 'browser-client',
      name: 'Browser',
      protocolVersion: 1,
    });
    const events = await client.listSession.events({
      listId: created.list.id,
      sessionId: opened.sessionId,
      cursor: opened.eventCursor,
    });
    const ack = await client.item.add({
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'browser-client',
      operationId: 'browser-op-1',
      name: 'Milk',
      tempItemId: 'temp:browser-op-1',
    });
    const event = await events.next();

    expect(ack).toMatchObject({ status: 'accepted', revision: 1, tempItemId: 'temp:browser-op-1' });
    expect(event.value).toMatchObject({ kind: 'state', snapshot: { list: { revision: 1 }, items: [{ name: 'Milk' }] } });
  });

  it('keeps presence, typed failures, and terminal deletion on the wire', async () => {
    const port = await startRealtimeServer();
    const first = await connect(port);
    const created = await first.list.create({ name: 'WebSocket lifecycle' });
    const opened = await first.listSession.open({
      listId: created.list.id,
      clientId: 'client-a',
      name: 'Alice',
      protocolVersion: 1,
    });
    const events = await first.listSession.events({
      listId: created.list.id,
      sessionId: opened.sessionId,
      cursor: opened.eventCursor,
    });

    const second = await connect(port);
    await second.listSession.open({
      listId: created.list.id,
      clientId: 'client-b',
      name: 'Bob',
      protocolVersion: 1,
    });
    const presence = await events.next();
    const presenceValue = presence.value as { kind: string; online?: Array<{ clientId: string }> };
    expect(presenceValue).toMatchObject({ kind: 'presence' });
    expect(presenceValue.online?.map((participant) => participant.clientId))
      .toEqual(expect.arrayContaining(['client-a', 'client-b']));

    await expect(first.item.add({
      listId: created.list.id,
      sessionId: 'missing-session',
      clientId: 'client-a',
      operationId: 'ws-forbidden',
      name: 'Milk',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    await expect(first.listSession.open({
      listId: created.list.id,
      clientId: 'client-old',
      name: 'Old client',
      protocolVersion: 999,
    })).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED', status: 426 });

    const deleted = await first.list.delete({
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'client-a',
      operationId: 'ws-delete',
      ownerToken: created.ownerToken,
    });
    expect(deleted).toMatchObject({ status: 'accepted' });
    const closed = await events.next();
    expect(closed.value).toMatchObject({ kind: 'list-closed', reason: 'deleted' });
    expect((await events.next()).done).toBe(true);
  });
});
