import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, type ShoplistApp } from '../src/server.js';

const apps: ShoplistApp[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length) apps.pop()?.store.close();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});

async function resource(options: Record<string, unknown> = {}): Promise<ShoplistApp> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-openapi-'));
  directories.push(directory);
  const resources = createApp({ dataFile: path.join(directory, 'db.sqlite'), ...options } as never);
  apps.push(resources);
  return resources;
}

interface JsonResult<T> {
  status: number;
  body: T;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const procedureMethods: Record<string, HttpMethod> = {
  '/list/get': 'GET',
  '/list/create': 'POST',
  '/list/leave': 'DELETE',
  '/list/clear': 'DELETE',
  '/list/rename': 'PATCH',
  '/list/delete': 'DELETE',
  '/push/config': 'GET',
  '/push/status': 'GET',
  '/push/register': 'POST',
  '/push/mute': 'PATCH',
  '/push/remove': 'DELETE',
  '/qr/generate': 'GET',
  '/listSession/open': 'POST',
  '/listSession/events': 'GET',
  '/item/add': 'POST',
  '/item/update': 'PATCH',
  '/item/delete': 'DELETE',
};

function queryUrl(pathName: string, input: unknown): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return `http://shoplist.test/api${pathName}${encoded ? `?${encoded}` : ''}`;
}

async function procedure<T>(resources: ShoplistApp, pathName: string, input: unknown): Promise<JsonResult<T>> {
  const method = procedureMethods[pathName];
  if (!method) throw new Error(`No HTTP method configured for ${pathName}`);
  const response = await resources.app.request(
    method === 'GET' ? queryUrl(pathName, input) : `http://shoplist.test/api${pathName}`,
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
  );
  return { status: response.status, body: await response.json() as T };
}

interface CreatedList {
  list: { id: string; name: string; createdAt: number; revision: number };
  ownerToken: string;
}

async function createList(resources: ShoplistApp, name = 'OpenAPI list'): Promise<CreatedList> {
  const created = await procedure<CreatedList>(resources, '/list/create', { name });
  expect(created.status).toBe(201);
  return created.body;
}

interface OpenedSession {
  protocolVersion: number;
  sessionId: string;
  eventCursor: string;
  snapshot: { list: { revision: number }; items: Array<{ name: string }> };
}

async function openSession(resources: ShoplistApp, listId: string, clientId = 'openapi-client'): Promise<OpenedSession> {
  const opened = await procedure<OpenedSession>(resources, '/listSession/open', {
    listId, clientId, name: 'OpenAPI client', protocolVersion: 1,
  });
  expect(opened.status).toBe(200);
  return opened.body;
}

interface SseFrame {
  event: string | undefined;
  id: string | undefined;
  data: string;
}

/** Minimal SSE reader so tests observe the wire format rather than server internals. */
class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private ended = false;

  public constructor(public readonly response: Response) {
    if (!response.body) throw new Error('event stream has no body');
    this.reader = response.body.getReader();
  }

  private async fill(timeoutMs: number): Promise<void> {
    const read = this.reader.read();
    read.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timed out waiting for an event-stream frame')), timeoutMs);
    });
    try {
      const result = await Promise.race([read, timeout]) as ReadableStreamReadResult<Uint8Array>;
      if (result.done) {
        this.ended = true;
        return;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read one raw frame, including keep-alive comments. */
  public async frame(timeoutMs = 2000): Promise<SseFrame> {
    while (true) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const lines = raw.split('\n');
        return {
          event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim(),
          id: lines.find((line) => line.startsWith('id:'))?.slice(3).trim(),
          data: lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'),
        };
      }
      if (this.ended) throw new Error('event stream ended before a frame arrived');
      await this.fill(timeoutMs);
    }
  }

  /** Read the next data frame, skipping comments such as the initial flush and keep-alives. */
  public async event<T = Record<string, unknown>>(timeoutMs = 2000): Promise<T> {
    while (true) {
      const frame = await this.frame(timeoutMs);
      if (frame.data) return JSON.parse(frame.data) as T;
    }
  }

  /** Resolve once the server closes the stream. */
  public async end(timeoutMs = 2000): Promise<void> {
    while (!this.ended) {
      const read = this.reader.read();
      read.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for the event stream to end')), timeoutMs);
      });
      try {
        const result = await Promise.race([read, timeout]) as ReadableStreamReadResult<Uint8Array>;
        if (result.done) {
          this.ended = true;
          return;
        }
        this.buffer += this.decoder.decode(result.value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  public async cancel(): Promise<void> {
    if (this.ended) return;
    await this.reader.cancel();
    this.ended = true;
  }
}

async function eventStream(resources: ShoplistApp, input: Record<string, unknown>): Promise<SseStream> {
  const response = await resources.app.request(queryUrl('/listSession/events', input), {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return new SseStream(response);
}

interface SessionEvent {
  kind: 'state' | 'presence' | 'list-closed' | 'upgrade-required';
  protocolVersion: number;
  eventCursor: string;
  snapshot?: { list: { revision: number }; items: Array<{ name: string }> };
  online?: Array<{ clientId: string }>;
}

describe('OpenAPI transport at /api', () => {
  it('serves the shared procedures as conventional HTTP operations', async () => {
    const resources = await resource({ pushPublicKey: 'public-key', pushSender: { send: async () => undefined } });
    const created = await createList(resources, 'Groceries');
    expect(created.list.revision).toBe(0);
    expect(created.ownerToken).toBeTruthy();

    const fetched = await procedure<{ list: { id: string; revision: number }; items: unknown[]; members: unknown[] }>(
      resources, '/list/get', { id: created.list.id },
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ list: { id: created.list.id, revision: 0 }, items: [], members: [] });

    const opened = await openSession(resources, created.list.id);
    expect(opened.protocolVersion).toBe(1);
    expect(opened.sessionId).toBeTruthy();

    const added = await procedure<{ status: string; revision: number; itemId: string; tempItemId: string }>(resources, '/item/add', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-add',
      name: 'Milk',
      amount: '2 L',
      tempItemId: 'temp:openapi-add',
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ status: 'accepted', revision: 1, tempItemId: 'temp:openapi-add' });
    expect(added.body.itemId).toBeTruthy();

    const duplicate = await procedure<{ status: string; revision: number }>(resources, '/item/add', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-add',
      name: 'Milk',
      amount: '2 L',
      tempItemId: 'temp:openapi-add',
    });
    expect(duplicate.body).toMatchObject({ status: 'accepted', revision: 1 });

    const pushConfig = await procedure<{ publicKey: string | null; available: boolean }>(resources, '/push/config', {});
    expect(pushConfig.body).toEqual({ publicKey: 'public-key', available: true });
    const registered = await procedure<{ enabled: boolean; muted: boolean }>(resources, '/push/register', {
      listId: created.list.id,
      clientId: 'openapi-client',
      subscription: { endpoint: 'https://push.example/openapi', keys: { p256dh: 'public', auth: 'auth' } },
    });
    expect(registered.body).toMatchObject({ enabled: true, muted: false });
    const muted = await procedure<{ muted: boolean }>(resources, '/push/mute', {
      listId: created.list.id, clientId: 'openapi-client', muted: true,
    });
    expect(muted.body).toMatchObject({ muted: true });
    const removed = await procedure<{ enabled: boolean }>(resources, '/push/remove', {
      listId: created.list.id, clientId: 'openapi-client',
    });
    expect(removed.body).toMatchObject({ enabled: false });

    const qr = await procedure<{ svg: string }>(resources, '/qr/generate', { data: 'https://shoplist.test/#/join/list' });
    expect(qr.body.svg).toContain('<svg');

    const left = await procedure<{ left: boolean }>(resources, '/list/leave', {
      listId: created.list.id, clientId: 'openapi-client',
    });
    expect(left.body).toEqual({ left: true });
  });

  it('emits declared failures with safe structured data and keeps the list revision', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);

    const missing = await procedure<Record<string, unknown>>(resources, '/list/get', { id: 'missing-list' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      defined: true,
      code: 'NOT_FOUND',
      status: 404,
      data: { code: 'NOT_FOUND', message: 'The list no longer exists.', retryable: false },
    });

    const invalid = await procedure<Record<string, unknown>>(resources, '/item/add', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-invalid',
      name: 42,
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain('stack');

    const forbidden = await procedure<Record<string, unknown>>(resources, '/item/add', {
      listId: created.list.id,
      sessionId: 'missing-session',
      clientId: 'openapi-client',
      operationId: 'openapi-forbidden',
      name: 'Milk',
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({
      defined: true,
      code: 'FORBIDDEN',
      data: { code: 'FORBIDDEN', retryable: false },
    });

    const upgrade = await procedure<Record<string, unknown>>(resources, '/listSession/open', {
      listId: created.list.id, clientId: 'openapi-client', name: 'OpenAPI client', protocolVersion: 999,
    });
    expect(upgrade.status).toBe(426);
    expect(upgrade.body).toMatchObject({ defined: true, code: 'UPGRADE_REQUIRED', status: 426 });

    const denied = await procedure<{ status: string; reason: string; revision: number }>(resources, '/list/delete', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-delete-denied',
      ownerToken: 'wrong',
    });
    expect(denied.body).toMatchObject({ status: 'rejected', reason: 'not-owner', revision: 0 });

    const fetched = await procedure<{ list: { revision: number } }>(resources, '/list/get', { id: created.list.id });
    expect(fetched.body.list.revision).toBe(0);
  });

  it('streams list-session events over SSE with the same event semantics', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);
    const stream = await eventStream(resources, {
      listId: created.list.id, sessionId: opened.sessionId, cursor: opened.eventCursor,
    });

    // The initial comment flushes the response before the first event arrives.
    const initial = await stream.frame();
    expect(initial.data).toBe('');

    const added = await procedure<{ revision: number }>(resources, '/item/add', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-sse-add',
      name: 'Bread',
      amount: '1 loaf',
    });
    expect(added.body.revision).toBe(1);

    const state = await stream.event<SessionEvent>();
    expect(state.kind).toBe('state');
    expect(state.eventCursor).toBeTruthy();
    expect(state.snapshot?.list.revision).toBe(1);
    expect(state.snapshot?.items).toEqual([expect.objectContaining({ name: 'Bread', amount: '1 loaf' })]);

    await stream.cancel();
  });

  it('keeps transport cursors separate from durable list revisions', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);
    expect(Number(opened.eventCursor)).toBe(1);
    expect(opened.snapshot.list.revision).toBe(0);

    const reopened = await procedure<OpenedSession>(resources, '/listSession/open', {
      listId: created.list.id, clientId: 'second-client', name: 'Second', protocolVersion: 1,
    });
    expect(Number(reopened.body.eventCursor)).toBe(2);
    expect(reopened.body.snapshot.list.revision).toBe(0);

    const stream = await eventStream(resources, {
      listId: created.list.id, sessionId: reopened.body.sessionId, cursor: opened.eventCursor,
    });
    const presence = await stream.event<SessionEvent>();
    expect(presence.kind).toBe('presence');
    expect(presence.eventCursor).toBe('2');
    expect((await procedure<{ list: { revision: number } }>(resources, '/list/get', { id: created.list.id })).body.list.revision).toBe(0);

    await procedure(resources, '/item/add', {
      listId: created.list.id,
      sessionId: reopened.body.sessionId,
      clientId: 'second-client',
      operationId: 'openapi-cursor-add',
      name: 'Eggs',
    });
    const state = await stream.event<SessionEvent>();
    expect(state.kind).toBe('state');
    expect(Number(state.eventCursor)).toBeGreaterThan(Number(presence.eventCursor));
    expect(state.snapshot?.list.revision).toBe(1);
    await stream.cancel();
  });

  it('keeps an idle SSE stream alive with periodic comments', async () => {
    const resources = await resource({ eventStream: { keepAliveIntervalMs: 25 } });
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);
    const stream = await eventStream(resources, {
      listId: created.list.id, sessionId: opened.sessionId, cursor: opened.eventCursor,
    });

    // The first frame flushes the response; the next one is a keep-alive.
    expect((await stream.frame()).data).toBe('');
    expect((await stream.frame(1000)).data).toBe('');
    await stream.cancel();
  });

  it('releases the list-session subscription when the SSE response is cancelled', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const first = await openSession(resources, created.list.id, 'first-client');
    const firstStream = await eventStream(resources, {
      listId: created.list.id, sessionId: first.sessionId, cursor: first.eventCursor,
    });

    const second = await openSession(resources, created.list.id, 'second-client');
    const joined = await firstStream.event<SessionEvent>();
    expect(joined.kind).toBe('presence');
    expect(joined.online?.map((participant) => participant.clientId)).toEqual(expect.arrayContaining(['first-client', 'second-client']));

    const secondStream = await eventStream(resources, {
      listId: created.list.id, sessionId: second.sessionId, cursor: second.eventCursor,
    });
    await firstStream.cancel();

    const left = await secondStream.event<SessionEvent>();
    expect(left.kind).toBe('presence');
    expect(left.online?.map((participant) => participant.clientId)).toEqual(['second-client']);
    expect(resources.rpcSessions.online(created.list.id).map((participant) => participant.clientId)).toEqual(['second-client']);
    await secondStream.cancel();
  });

  it('completes the SSE stream after the terminal list-closed outcome', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);
    const stream = await eventStream(resources, {
      listId: created.list.id, sessionId: opened.sessionId, cursor: opened.eventCursor,
    });

    const deleted = await procedure<{ status: string; revision: number }>(resources, '/list/delete', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-sse-delete',
      ownerToken: created.ownerToken,
    });
    expect(deleted.body).toMatchObject({ status: 'accepted' });

    const closed = await stream.event<SessionEvent>();
    expect(closed.kind).toBe('list-closed');
    await stream.end();
  });

  it('replays events after a transport cursor without reapplying a mutation', async () => {
    const resources = await resource();
    const created = await createList(resources);
    const opened = await openSession(resources, created.list.id);
    const beforeMutation = opened.eventCursor;

    await procedure(resources, '/item/add', {
      listId: created.list.id,
      sessionId: opened.sessionId,
      clientId: 'openapi-client',
      operationId: 'openapi-resume-add',
      name: 'Butter',
    });

    const resumed = await eventStream(resources, {
      listId: created.list.id, sessionId: opened.sessionId, cursor: beforeMutation,
    });
    const replayed = await resumed.event<SessionEvent>();
    expect(replayed.kind).toBe('state');
    expect(replayed.snapshot?.list.revision).toBe(1);
    expect(replayed.snapshot?.items).toHaveLength(1);

    await resumed.cancel();
    const list = await procedure<{ list: { revision: number }; items: unknown[] }>(resources, '/list/get', { id: created.list.id });
    expect(list.body.list.revision).toBe(1);
    expect(list.body.items).toHaveLength(1);
  });

  it('documents the shared transport contract at /api/openapi.json', async () => {
    const resources = await resource();
    const response = await resources.app.request('http://shoplist.test/api/openapi.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const document = await response.json() as {
      openapi: string;
      info: { title: string; version: string };
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, {
        operationId?: string;
        parameters?: Array<{ in: string; name: string; schema?: Record<string, unknown> }>;
        requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
        responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }> }>;
      }>>;
    };

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info.title).toBeTruthy();
    expect(document.info.version).toBeTruthy();
    expect(document.servers).toEqual([expect.objectContaining({ url: '/api' })]);
    for (const [pathName, method] of Object.entries(procedureMethods)) {
      const operation = document.paths[pathName][method.toLowerCase()];
      expect(operation?.operationId, `${method} ${pathName}`).toBe(pathName.slice(1).replace('/', '.'));
    }

    const getOperation = document.paths['/list/get'].get;
    expect(getOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'query', name: 'id' }),
    ]));
    const successSchema = getOperation.responses['200'].content?.['application/json']?.schema;
    expect(JSON.stringify(successSchema)).toContain('memberCount');
    expect(getOperation.responses['404']).toBeTruthy();
    expect(getOperation.responses['403']).toBeTruthy();
    expect(getOperation.responses['409']).toBeTruthy();
    expect(getOperation.responses['500']).toBeTruthy();
    const notFoundSchema = JSON.stringify(getOperation.responses['404']);
    expect(notFoundSchema).toContain('"defined"');
    expect(notFoundSchema).toContain('NOT_FOUND');
    expect(notFoundSchema).toContain('retryable');

    const events = document.paths['/listSession/events'].get;
    expect(events.responses['200'].content?.['text/event-stream']).toBeTruthy();
    expect(JSON.stringify(events.responses)).toContain('eventCursor');

    // The generated document must describe the OpenAPI surface, not the native transport.
    expect(Object.keys(document.paths).some((path) => path.startsWith('/rpc'))).toBe(false);
    expect(document.servers.every((server) => !server.url.includes('/rpc'))).toBe(true);
  });

  it('serves interactive Scalar documentation backed by the generated document', async () => {
    const resources = await resource();
    const response = await resources.app.request('http://shoplist.test/api/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('/api/openapi.json');

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps the strict application policy outside the documentation route', async () => {
    const resources = await resource();
    const response = await resources.app.request('http://shoplist.test/healthz');
    expect(response.headers.get('content-security-policy')).toContain("style-src 'self'");
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  });

  it('rejects the removed legacy /api routes with an explicit response', async () => {
    const resources = await resource();
    const legacy = [
      ['POST', '/api/lists'],
      ['GET', '/api/lists/some-list'],
      ['GET', '/api/qr?data=invite'],
      ['GET', '/api/push/old-config'],
      ['GET', '/api/lists/some-list/notifications?client=a'],
      ['PUT', '/api/lists/some-list/notifications'],
      ['PATCH', '/api/lists/some-list/notifications'],
      ['DELETE', '/api/lists/some-list/notifications?client=a'],
      ['POST', '/api/lists/some-list/leave'],
      ['GET', '/api/unknown'],
      ['POST', '/api/unknown'],
    ] as const;

    for (const [method, target] of legacy) {
      const response = await resources.app.request(`http://shoplist.test${target}`, { method });
      expect(response.status, `${method} ${target}`).toBe(404);
      expect(response.headers.get('content-type'), `${method} ${target}`).toContain('application/json');
      expect(await response.json(), `${method} ${target}`).toEqual({ error: 'procedure not found' });
    }
  });

  it('removes the custom /ws endpoint while keeping /rpc', async () => {
    const resources = await resource();
    const ws = await resources.app.request('http://shoplist.test/ws');
    expect(ws.status).toBe(404);
    expect(await ws.json()).toEqual({ error: 'not found' });

    const created = await createList(resources);
    const rpc = await resources.app.request('http://shoplist.test/rpc/list/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { id: created.list.id } }),
    });
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toMatchObject({ json: { list: { id: created.list.id } } });
  });
});
