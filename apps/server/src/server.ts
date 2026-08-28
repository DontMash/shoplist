import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono, type Context, type Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  cleanText,
  Store,
  type ItemPatch,
  type ShoppingItem,
  type ShoppingList,
} from './store.js';
import type { WSContext } from 'hono/ws';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_DIR = path.resolve(SERVER_DIR, '../web/dist');
const LIST_ID = /^[A-Za-z0-9_-]{4,40}$/;
const BODY_LIMIT = 16 * 1024;

export const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; manifest-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
} as const;

export interface AppOptions {
  dataFile?: string;
  publicDir?: string;
  store?: Store;
}

export interface ShoplistApp {
  app: Hono;
  store: Store;
  rooms: Rooms;
}

interface ClientInfo {
  clientId: string;
  name: string;
  color: string;
}

type Socket = WSContext;
type Room = Map<Socket, ClientInfo>;
type Rooms = Map<string, Room>;

export interface StartOptions extends AppOptions {
  port?: number;
  host?: string;
  onListening?: (port: number) => void;
}

export interface RunningServer extends ShoplistApp {
  server: ServerType;
  close: () => Promise<void>;
}

const PALETTE = [
  '#e11d48', '#0284c7', '#7c3aed', '#ea580c',
  '#0d9488', '#c026d3', '#4f46e5', '#65a30d',
];

export function colorFor(clientId: string): string {
  let hash = 0;
  for (let index = 0; index < clientId.length; index += 1) {
    hash = (hash * 31 + clientId.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export function publicItem(item: ShoppingItem): Omit<ShoppingItem, 'by'> & { by?: string | null } {
  // Do not leak a removed legacy status even if a database is inspected before
  // its migration save runs.
  const copy = { ...item } as Omit<ShoppingItem, 'by'> & { by?: string | null; shopped?: unknown };
  delete copy.shopped;
  return copy;
}

function listPayload(list: ShoppingList) {
  return {
    id: list.id,
    name: list.name,
    createdAt: list.createdAt,
    items: list.items.map(publicItem),
  };
}

export function onlineIn(rooms: Rooms, listId: string): ClientInfo[] {
  const room = rooms.get(listId);
  if (!room) return [];
  const seen = new Set<string>();
  const online: ClientInfo[] = [];
  for (const info of room.values()) {
    if (seen.has(info.clientId)) continue;
    seen.add(info.clientId);
    online.push(info);
  }
  return online;
}

export function broadcast(rooms: Rooms, listId: string, message: unknown, except?: Socket): void {
  const room = rooms.get(listId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const socket of room.keys()) {
    if (socket === except || socket.readyState !== 1) continue;
    try {
      socket.send(data);
    } catch {
      // A connection can close between the ready-state check and send.
    }
  }
}

function pushState(rooms: Rooms, list: ShoppingList, actor?: ClientInfo): void {
  // Full-state sync keeps clients trivially consistent. Broadcast to the
  // actor as well: it is useful for resolving optimistic local changes.
  broadcast(rooms, list.id, {
    t: 'state',
    list: listPayload(list),
    actor: actor ? { clientId: actor.clientId, name: actor.name } : null,
  });
}

function pushPresence(rooms: Rooms, listId: string): void {
  broadcast(rooms, listId, { t: 'presence', online: onlineIn(rooms, listId) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (Array.isArray(data)) return new TextDecoder().decode(Uint8Array.from(data));
  return '';
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients are allowed
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

function withBaseHeaders(c: Context): void {
  for (const [name, value] of Object.entries(BASE_HEADERS)) c.header(name, value);
}

function json(c: Context, status: number, body: unknown, cache = 'no-store'): Response {
  c.header('Cache-Control', cache);
  return c.json(body, status as ContentfulStatusCode);
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > BODY_LIMIT) throw new Error('body too large');
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) throw new Error('body too large');
  const parsed: unknown = JSON.parse(text || '{}');
  return isRecord(parsed) ? parsed : {};
}

function sameOriginMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!sameOrigin(c.req.raw)) return json(c, 403, { error: 'bad origin' });
    return next();
  };
}

/** Create the Hono application without opening a listening socket. */
export function createApp(options: AppOptions = {}): ShoplistApp {
  const dataFile = options.dataFile || path.join(process.env.DATA_DIR || path.join(SERVER_DIR, 'data'), 'db.sqlite');
  const publicDir = options.publicDir || process.env.PUBLIC_DIR || BUILT_DIR;
  const store = options.store || new Store(dataFile);
  const rooms: Rooms = new Map();
  const app = new Hono();

  app.use('*', async (c, next) => {
    withBaseHeaders(c);
    return next();
  });

  app.onError((error, c) => {
    console.error('[http] error:', error);
    return json(c, 500, { error: 'internal error' });
  });

  app.get('/healthz', (c) => json(c, 200, { ok: true, lists: store.listCount() }));

  app.post('/api/lists', sameOriginMiddleware(), async (c) => {
    if (!/^application\/json/i.test(c.req.header('content-type') || '')) {
      return json(c, 415, { error: 'expected application/json' });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(c);
    } catch (error) {
      return json(c, error instanceof Error && error.message === 'body too large' ? 413 : 400,
        { error: error instanceof Error && error.message === 'body too large' ? 'body too large' : 'invalid json' });
    }
    const list = store.createList(body.name);
    return json(c, 201, {
      list: { id: list.id, name: list.name, createdAt: list.createdAt },
      ownerToken: list.ownerToken,
    });
  });

  app.get('/api/lists/:id', (c) => {
    const id = c.req.param('id');
    if (!LIST_ID.test(id)) return json(c, 404, { error: 'list not found' });
    const list = store.getList(id);
    if (!list) return json(c, 404, { error: 'list not found' });
    return json(c, 200, {
      list: { id: list.id, name: list.name, createdAt: list.createdAt },
      items: list.items.map(publicItem),
      memberCount: store.memberCount(list),
    });
  });

  app.get('/api/qr', async (c) => {
    const data = c.req.query('data') || '';
    if (!data || data.length > 512) return json(c, 400, { error: 'bad data' });
    try {
      const svg = await QRCode.toString(data, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 256,
      });
      c.header('Content-Type', 'image/svg+xml; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=86400');
      return c.body(svg, 200);
    } catch {
      return json(c, 400, { error: 'could not encode data' });
    }
  });

  app.get('/favicon.ico', (c) => c.redirect('/icons/favicon.svg', 302));

  app.get('/ws', sameOriginMiddleware(), upgradeWebSocket((c) => {
    let connection: {
      listId: string;
      clientId: string;
      name: string;
      info: ClientInfo;
      socket: Socket;
    } | null = null;

    return {
      onOpen(_event, socket) {
        const listId = (c.req.query('list') || '').slice(0, 40);
        const clientId = cleanText(c.req.query('client'), 64);
        const name = cleanText(c.req.query('name'), 40) || 'Guest';
        const list = store.getList(listId);
        if (!clientId || !list) {
          socket.close(4004, !clientId ? 'missing-client-id' : 'list-not-found');
          return;
        }

        const info: ClientInfo = { clientId, name, color: colorFor(clientId) };
        let room = rooms.get(list.id);
        if (!room) {
          room = new Map();
          rooms.set(list.id, room);
        }
        room.set(socket, info);
        connection = { listId: list.id, clientId, name, info, socket };
        store.touchMember(list, clientId, name, info.color);

        socket.send(JSON.stringify({
          t: 'init',
          you: { clientId, color: info.color },
          list: listPayload(list),
          online: onlineIn(rooms, list.id),
        }));
        pushPresence(rooms, list.id);
      },

      onMessage(event, socket) {
        if (!connection || connection.socket !== socket) return;
        let message: unknown;
        try {
          message = JSON.parse(messageText(event.data));
        } catch {
          return; // Ignore garbage without taking down the connection.
        }
        if (!isRecord(message) || typeof message.t !== 'string') return;

        const current = store.getList(connection.listId);
        if (!current) {
          socket.close(4004, 'list-not-found');
          return;
        }

        switch (message.t) {
          case 'ping':
            socket.send(JSON.stringify({ t: 'pong' }));
            break;

          case 'item:add': {
            const item = store.addItem(current, isRecord(message.item) ? message.item : {}, connection.clientId);
            if (item) pushState(rooms, current, connection.info);
            break;
          }

          case 'item:update': {
            if (!message.id || !isRecord(message.patch)) break;
            const patch: ItemPatch = {};
            if ('name' in message.patch) patch.name = message.patch.name;
            if ('amount' in message.patch) patch.amount = message.patch.amount;
            if ('collected' in message.patch) patch.collected = message.patch.collected;
            if (store.updateItem(current, String(message.id), patch)) pushState(rooms, current, connection.info);
            break;
          }

          case 'item:delete':
            if (message.id && store.deleteItem(current, String(message.id))) pushState(rooms, current, connection.info);
            break;

          case 'list:clear':
            store.clearList(current);
            pushState(rooms, current, connection.info);
            break;

          case 'list:rename':
            if (store.renameList(current, message.name)) pushState(rooms, current, connection.info);
            break;

          case 'list:delete': {
            if (message.ownerToken !== current.ownerToken) {
              socket.send(JSON.stringify({ t: 'error', message: 'Only the list owner can delete it.' }));
              break;
            }
            const id = current.id;
            store.deleteList(id);
            broadcast(rooms, id, { t: 'closed', reason: 'deleted' });
            for (const roomSocket of rooms.get(id)?.keys() || []) {
              try {
                roomSocket.close(1000, 'list-deleted');
              } catch {
                // noop
              }
            }
            rooms.delete(id);
            break;
          }

          default:
            break; // Unknown message types are ignored for forward compatibility.
        }
      },

      onClose() {
        if (!connection) return;
        const room = rooms.get(connection.listId);
        if (!room) return;
        room.delete(connection.socket);
        if (room.size === 0) rooms.delete(connection.listId);
        else pushPresence(rooms, connection.listId);
        connection = null;
      },

      onError() {
        // The adapter will close the connection; onClose removes it from the room.
      },
    };
  }));

  // API routes above take precedence. The Node static middleware safely
  // confines requests to publicDir and returns 404 for missing files.
  app.get('*', serveStatic({ root: publicDir }));
  app.on(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], '*', (c) => json(c, 405, { error: 'method not allowed' }));
  app.notFound((c) => json(c, 404, { error: 'not found' }));

  return { app, store, rooms };
}

/** Start the one HTTP + WebSocket server used in production and development. */
export function startServer(options: StartOptions = {}): RunningServer {
  const resources = createApp(options);
  const websocketServer = new WebSocketServer({ noServer: true });
  const port = options.port ?? (Number(process.env.PORT) || 3000);
  const host = options.host || process.env.HOST || '0.0.0.0';
  const server = serve({
    fetch: resources.app.fetch,
    port,
    hostname: host,
    websocket: { server: websocketServer },
  }, (info) => {
    console.log(`Shoplist running on http://${host}:${info.port} (data: ${resources.store.file})`);
    options.onListening?.(info.port);
  });

  let stopped = false;
  const close = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    resources.store.flushSync();
    for (const room of resources.rooms.values()) {
      for (const socket of room.keys()) {
        try {
          socket.close(1001, 'server shutting down');
        } catch {
          // noop
        }
      }
    }
    resources.rooms.clear();
    resources.store.close();
    websocketServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { ...resources, server, close };
}

async function runCli(): Promise<void> {
  const running = startServer();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down, saving data…');
    await running.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedFile === import.meta.url) void runCli();
