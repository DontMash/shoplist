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

afterEach(async () => {
  while (runningServers.length) await runningServers.pop()!.close();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});

describe('public /rpc WebSocket seam', () => {
  it('opens a list session, accepts item.add, and emits its full-state event', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-rpc-ws-'));
    directories.push(directory);
    let port = 0;
    const listening = new Promise<void>((resolve) => {
      const server = startServer({
        port: 0,
        host: '127.0.0.1',
        dataFile: path.join(directory, 'db.sqlite'),
        publicDir: directory,
        onListening: (value) => { port = value; resolve(); },
      });
      runningServers.push(server);
    });
    await listening;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const client = createORPCClient<ContractRouterClient<TransportContract>>(
      new RPCLink({ websocket: socket as unknown as WebSocket }),
    );
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
    socket.close();
  });
});
