import { describe, expect, it } from 'vitest';
import { getEventIteratorSchemaDetails, type AnySchema } from '@orpc/contract';
import {
  PROTOCOL_VERSION,
  operationErrors,
  sessionEventSchema,
  transportContract,
} from '../src/index.js';

type AnyContractProcedure = {
  '~orpc': {
    route: { method: string; path: string; operationId: string };
    outputSchema?: AnySchema;
  };
};

const procedurePaths: ReadonlyArray<readonly [string, string]> = [
  ['list', 'get'],
  ['list', 'create'],
  ['list', 'leave'],
  ['list', 'clear'],
  ['list', 'rename'],
  ['list', 'delete'],
  ['push', 'config'],
  ['push', 'status'],
  ['push', 'register'],
  ['push', 'mute'],
  ['push', 'remove'],
  ['qr', 'generate'],
  ['listSession', 'open'],
  ['listSession', 'events'],
  ['item', 'add'],
  ['item', 'update'],
  ['item', 'delete'],
];

function procedureAt(path: readonly [string, string]): AnyContractProcedure {
  let node: unknown = transportContract;
  for (const key of path) {
    node = (node as Record<string, unknown>)[key];
  }
  return node as AnyContractProcedure;
}

describe('shared transport contract', () => {
  it('declares every procedure as an explicit POST operation with a stable identity', () => {
    for (const path of procedurePaths) {
      const route = procedureAt(path)['~orpc'].route;
      expect(route.method, path.join('.')).toBe('POST');
      expect(route.operationId, path.join('.')).toBe(path.join('.'));
      expect(route.path, path.join('.')).toBe(`/${path.join('/')}`);
    }
  });

  it('pins the protocol version and the declared transport errors', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Object.fromEntries(Object.entries(operationErrors).map(([code, config]) => [code, config.status]))).toEqual({
      BAD_REQUEST: 400,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INTERNAL_SERVER_ERROR: 500,
      UPGRADE_REQUIRED: 426,
    });
  });

  it('exposes listSession.events as an event iterator of session events', () => {
    const details = getEventIteratorSchemaDetails(procedureAt(['listSession', 'events'])['~orpc'].outputSchema);
    expect(details).toBeDefined();
    expect(sessionEventSchema.safeParse({
      kind: 'presence',
      protocolVersion: PROTOCOL_VERSION,
      eventCursor: '1',
      online: [],
      members: [],
    }).success).toBe(true);
    expect(sessionEventSchema.safeParse({
      kind: 'state',
      protocolVersion: PROTOCOL_VERSION,
      snapshot: {
        list: { id: 'list', name: 'Groceries', createdAt: 1, revision: 0 },
        items: [],
        members: [],
      },
      actor: null,
    }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ kind: 'list-closed', protocolVersion: PROTOCOL_VERSION, eventCursor: '2', reason: 'deleted' }).success)
      .toBe(true);
  });

  it('restricts push destinations to bounded https endpoints', () => {
    const inputSchema = (procedureAt(['push', 'register']) as unknown as {
      '~orpc': { inputSchema: { safeParse: (value: unknown) => { success: boolean } } };
    })['~orpc'].inputSchema;
    const input = {
      listId: 'list',
      clientId: 'client',
      subscription: { endpoint: 'https://push.example/a', keys: { p256dh: 'public', auth: 'auth' } },
    };
    expect(inputSchema.safeParse(input).success).toBe(true);
    expect(inputSchema.safeParse({
      ...input,
      subscription: { ...input.subscription, endpoint: 'http://push.example/a' },
    }).success).toBe(false);
    expect(inputSchema.safeParse({
      ...input,
      subscription: { ...input.subscription, endpoint: 'not-a-url' },
    }).success).toBe(false);
  });
});
