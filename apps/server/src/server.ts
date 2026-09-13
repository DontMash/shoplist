import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono, type Context, type Next } from 'hono';
import { secureHeaders, NONCE } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { RPCHandler as FetchRPCHandler, BodyLimitPlugin } from '@orpc/server/fetch';
import { RPCHandler as WebSocketRPCHandler } from '@orpc/server/ws';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { Scalar } from '@scalar/hono-api-reference';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { NotificationDispatcher, WebPushSender, type PushSender } from './notifications.js';
import { loadServerEnv, type ServerEnv } from './env.js';
import { createRpcRouter, RpcEventPublisher, RpcSessionRegistry } from './rpc.js';
import { OPENAPI_SERVER_URL, OPENAPI_TITLE, openApiDocument } from './openapi.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_DIR = path.resolve(SERVER_DIR, '../web/dist');

function safeBuildId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : 'unknown';
}

const APPLICATION_CSP = {
  defaultSrc: ["'none'"],
  styleSrc: ["'self'"],
  scriptSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  manifestSrc: ["'self'"],
  fontSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/**
 * Scalar loads its standalone bundle from a pinned CDN and initializes it with
 * an inline script, so the page needs a nonce and the CDN origin. Scalar also
 * renders inline `style="..."` attributes, which a nonce cannot authorize, so
 * inline styles are allowed on this route. Every other route keeps the
 * application CSP unchanged.
 */
const DOCUMENTATION_CSP = {
  defaultSrc: ["'none'"],
  scriptSrc: [NONCE, "'self'", 'https://cdn.jsdelivr.net'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  imgSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
  fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
  connectSrc: ["'self'", 'https://cdn.jsdelivr.net'],
  manifestSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

// Keep the response contract stable while delegating security-header emission
// and nonce generation to Hono. The defaults are intentionally disabled: this
// application has not opted into the additional headers secureHeaders() adds.
const SECURITY_HEADER_OPTIONS = {
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: false,
  xContentTypeOptions: 'nosniff',
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xFrameOptions: 'DENY',
  xPermittedCrossDomainPolicies: false,
  xXssProtection: false,
  removePoweredBy: false,
};

const applicationSecurityHeaders = secureHeaders({
  ...SECURITY_HEADER_OPTIONS,
  contentSecurityPolicy: APPLICATION_CSP,
});

const documentationSecurityHeaders = secureHeaders({
  ...SECURITY_HEADER_OPTIONS,
  contentSecurityPolicy: DOCUMENTATION_CSP,
});

/** Explicit event-stream behavior for the OpenAPI fetch handler. */
export interface EventStreamOptions {
  keepAliveEnabled?: boolean;
  keepAliveIntervalMs?: number;
  initialCommentEnabled?: boolean;
}

export interface AppOptions {
  dataFile?: string;
  publicDir?: string;
  store?: Store;
  publicOrigin?: string;
  buildId?: string;
  pushPublicKey?: string;
  pushSender?: PushSender;
  notificationCoalesceMs?: number;
  eventStream?: EventStreamOptions;
}

export interface ShoplistApp {
  app: Hono;
  store: Store;
  rpcPublisher: RpcEventPublisher;
  rpcSessions: RpcSessionRegistry;
  buildId: string;
  dispatcher: NotificationDispatcher;
}

export interface StartOptions extends AppOptions {
  port?: number;
  host?: string;
  onListening?: (port: number) => void;
}

export interface RunningServer extends ShoplistApp {
  server: ServerType;
  close: () => Promise<void>;
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

export function sameOrigin(request: Request, publicOrigin?: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients are allowed
  try {
    const originUrl = new URL(origin);
    if (publicOrigin) {
      const configuredOrigin = new URL(publicOrigin);
      if (configuredOrigin.protocol !== 'http:' && configuredOrigin.protocol !== 'https:') return false;
      return originUrl.origin === configuredOrigin.origin;
    }

    // The Node listener sees the internal HTTP hop when TLS terminates at a
    // reverse proxy. Use the public origin metadata that standard proxies
    // forward, while still requiring an exact scheme, host, and port match.
    const requestUrl = new URL(request.url);
    const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'));
    const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'));
    if (forwardedProto && forwardedProto !== 'http' && forwardedProto !== 'https') return false;
    const requestOrigin = `${forwardedProto || requestUrl.protocol.slice(0, -1)}://${forwardedHost || request.headers.get('host') || requestUrl.host}`;
    const requestOriginUrl = new URL(requestOrigin);
    if (originUrl.origin === requestOriginUrl.origin) return true;

    // Some upgrade proxies preserve Host but omit the public scheme. An
    // HTTPS-origin WebSocket with an exact host match is still unambiguous;
    // never apply this fallback to ordinary HTTP requests or HTTP origins.
    return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      && requestUrl.protocol === 'http:'
      && originUrl.protocol === 'https:'
      && originUrl.host === requestOriginUrl.host;
  } catch {
    return false;
  }
}

function json(c: Context, status: number, body: unknown, cache = 'no-store'): Response {
  c.header('Cache-Control', cache);
  return c.json(body, status as ContentfulStatusCode);
}

function sameOriginMiddleware(publicOrigin?: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!sameOrigin(c.req.raw, publicOrigin)) return json(c, 403, { error: 'bad origin' });
    return next();
  };
}

function createAppWithEnv(options: AppOptions, environment: ServerEnv): ShoplistApp {
  const dataFile = options.dataFile || path.join(environment.DATA_DIR || path.join(SERVER_DIR, 'data'), 'db.sqlite');
  const publicDir = options.publicDir || environment.PUBLIC_DIR || BUILT_DIR;
  const publicOrigin = options.publicOrigin ?? environment.PUBLIC_ORIGIN;
  const buildId = safeBuildId(options.buildId ?? environment.BUILD_SHA);
  const store = options.store || new Store(dataFile);
  const configuredPushPublicKey = options.pushPublicKey ?? environment.VAPID_PUBLIC_KEY ?? '';
  const pushSender = options.pushSender || (
    environment.VAPID_PUBLIC_KEY && environment.VAPID_PRIVATE_KEY && environment.VAPID_SUBJECT
      ? new WebPushSender(environment.VAPID_PUBLIC_KEY, environment.VAPID_PRIVATE_KEY, environment.VAPID_SUBJECT)
      : undefined
  );
  const pushPublicKey = pushSender ? configuredPushPublicKey : '';
  const rpcPublisher = new RpcEventPublisher();
  const rpcSessions = new RpcSessionRegistry();
  // Online list-session participants are tracked by the native transport and
  // shared with notification delivery so an active participant is not pushed.
  const dispatcher = new NotificationDispatcher(store, pushSender, (listId) => rpcSessions.onlineClientIds(listId), {
    coalesceMs: options.notificationCoalesceMs,
  });
  const rpcRouter = createRpcRouter({
    store,
    publisher: rpcPublisher,
    sessions: rpcSessions,
    dispatcher,
    publicKey: pushPublicKey,
  });
  const rpcHttpHandler = new FetchRPCHandler(rpcRouter);
  const rpcWebSocketHandler = new WebSocketRPCHandler(rpcRouter);
  // One router, two transports: the native oRPC handler and the OpenAPI
  // handler both invoke the same procedures, so behavior cannot drift.
  const openApiHandler = new OpenAPIHandler(rpcRouter, {
    // The removed compatibility routes enforced this body limit; keep the
    // OpenAPI transport bounded as well.
    plugins: [new BodyLimitPlugin({ maxBodySize: 16 * 1024 })],
    // Event-stream behavior is explicit: flush headers with an initial
    // comment, keep idle streams alive, and let cancellation end the
    // iterator. Empty streams complete normally.
    eventIteratorKeepAliveEnabled: options.eventStream?.keepAliveEnabled ?? true,
    eventIteratorKeepAliveInterval: options.eventStream?.keepAliveIntervalMs ?? 5_000,
    eventIteratorInitialCommentEnabled: options.eventStream?.initialCommentEnabled ?? true,
  });
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('X-Shoplist-Build', buildId);
    const securityHeaders = c.req.path === '/api/docs'
      ? documentationSecurityHeaders
      : applicationSecurityHeaders;
    return securityHeaders(c, next);
  });

  app.onError((error, c) => {
    console.error('[http] error:', error);
    return json(c, 500, { error: 'internal error' });
  });

  app.get('/healthz', (c) => json(c, 200, { ok: true, lists: store.listCount(), build: buildId }));

  // Native oRPC transport. One logical endpoint serves unary calls over HTTP;
  // the WebSocket upgrade below uses the same prefix and router, but keeps a
  // separate oRPC handler because the wire framing differs from fetch.
  const rpcUpgrade = sameOriginMiddleware(publicOrigin);
  const rpcWebSocketRoute = upgradeWebSocket((c) => ({
    onOpen(_event, socket) {
      const raw = socket.raw;
      if (raw && typeof (raw as { addEventListener?: unknown }).addEventListener === 'function') {
        void rpcWebSocketHandler.upgrade(raw as unknown as Parameters<typeof rpcWebSocketHandler.upgrade>[0], { context: {} });
      } else {
        socket.close(1011, 'websocket adapter unavailable');
      }
    },
  }));
  app.get('/rpc/*', rpcUpgrade, rpcWebSocketRoute);
  app.get('/rpc', rpcUpgrade, rpcWebSocketRoute);

  const handleRpc = async (c: Context): Promise<Response> => {
    const result = await rpcHttpHandler.handle(c.req.raw, { prefix: '/rpc', context: {} });
    return result.matched ? result.response : json(c, 404, { error: 'procedure not found' });
  };
  app.all('/rpc/*', rpcUpgrade, handleRpc);
  app.all('/rpc', rpcUpgrade, handleRpc);

  // OpenAPI transport. The generated document and the Scalar reference are
  // read-only and served from the same /api origin as the procedures.
  app.get('/api/openapi.json', async (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(await openApiDocument(), 200);
  });

  app.get('/api/docs', async (c, next) => {
    const nonce = c.get('secureHeadersNonce');
    if (!nonce) return json(c, 500, { error: 'internal error' });
    return Scalar({
      url: `${OPENAPI_SERVER_URL}/openapi.json`,
      pageTitle: `${OPENAPI_TITLE} reference`,
      nonce,
    })(c, next);
  });

  const handleOpenApi = async (c: Context): Promise<Response> => {
    const result = await openApiHandler.handle(c.req.raw, { prefix: OPENAPI_SERVER_URL, context: {} });
    // Unsupported paths fail explicitly instead of falling through to the
    // frontend shell or an old compatibility handler.
    return result.matched ? result.response : json(c, 404, { error: 'procedure not found' });
  };
  app.all('/api', sameOriginMiddleware(publicOrigin), handleOpenApi);
  app.all('/api/*', sameOriginMiddleware(publicOrigin), handleOpenApi);

  app.get('/favicon.ico', (c) => c.redirect('/icons/favicon.svg', 302));

  // The Node static middleware safely confines requests to publicDir and
  // returns 404 for missing files.
  app.get('*', serveStatic({ root: publicDir }));
  app.on(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], '*', (c) => json(c, 405, { error: 'method not allowed' }));
  app.notFound((c) => json(c, 404, { error: 'not found' }));

  return { app, store, rpcPublisher, rpcSessions, buildId, dispatcher };
}

/** Create the Hono application without opening a listening socket. */
export function createApp(options: AppOptions = {}): ShoplistApp {
  return createAppWithEnv(options, loadServerEnv());
}

/** Start the one HTTP + WebSocket server used in production and development. */
export function startServer(options: StartOptions = {}): RunningServer {
  const environment = loadServerEnv();
  const resources = createAppWithEnv(options, environment);
  const websocketServer = new WebSocketServer({ noServer: true });
  const port = options.port ?? environment.PORT;
  const host = options.host || environment.HOST;
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
    resources.dispatcher.dispose();
    resources.store.flushSync();
    resources.rpcPublisher.closeAll();
    resources.rpcSessions.closeAll();
    for (const client of websocketServer.clients) {
      try { client.close(1001, 'server shutting down'); } catch { /* noop */ }
    }
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
