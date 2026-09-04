import { describe, expect, it, vi } from 'vitest';
import { browserListSessionTransport } from '../src/lib/list-session-transport';

describe('browser list session transport', () => {
  it('covers the browser transport wire lifecycle', () => {
    const RealWebSocket = globalThis.WebSocket;
    const RealLocation = globalThis.location;
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
    class FakeWebSocket {
      public static OPEN = 1;
      public static instances: FakeWebSocket[] = [];
      public readyState = 0;
      public onopen: (() => void) | null = null;
      public onmessage: ((event: { data: string }) => void) | null = null;
      public onclose: ((event: { code: number; reason: string }) => void) | null = null;
      public onerror: (() => void) | null = null;
      public sent: string[] = [];
      public constructor() { FakeWebSocket.instances.push(this); }
      public send(value: string): void { this.sent.push(value); }
      public close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'closed' }); }
      public open(): void { this.readyState = 1; this.onopen?.(); }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const received: unknown[] = [];
    const closed: unknown[] = [];
    const connection = browserListSessionTransport.connect({
      listId: 'list', clientId: 'client-a', name: '',
      onOpen: () => received.push('open'), onMessage: (message) => received.push(message),
      onClose: (info) => closed.push(info),
    });
    const fake = FakeWebSocket.instances[0];
    expect(() => connection.send({ operationId: 'not-open', kind: 'list:clear', payload: {} })).toThrow();
    fake.open();
    fake.onmessage?.({ data: '{' });
    fake.onmessage?.({ data: '{"t":"pong"}' });
    connection.send({ operationId: 'x', kind: 'item:add', payload: { tempItemId: 't', name: 'Milk', amount: '' } });
    connection.send({ operationId: 'x2', kind: 'item:update', payload: { id: 'i', patch: {} } });
    connection.send({ operationId: 'x3', kind: 'item:delete', payload: { id: 'i' } });
    connection.send({ operationId: 'x4', kind: 'list:clear', payload: {} });
    connection.send({ operationId: 'x5', kind: 'list:rename', payload: { name: 'X' } });
    connection.send({ operationId: 'x6', kind: 'list:delete', payload: { ownerToken: 'o' } });
    expect(fake.sent.map((value) => JSON.parse(value))).toEqual([
      { t: 'item:add', opId: 'x', tempId: 't', item: { name: 'Milk', amount: '' } },
      { t: 'item:update', opId: 'x2', id: 'i', patch: {} },
      { t: 'item:delete', opId: 'x3', id: 'i' },
      { t: 'list:clear', opId: 'x4' },
      { t: 'list:rename', opId: 'x5', name: 'X' },
      { t: 'list:delete', opId: 'x6', ownerToken: 'o' },
    ]);
    fake.onerror?.();
    connection.close();
    expect(() => connection.send({ operationId: 'closed', kind: 'list:clear', payload: {} })).toThrow();
    globalThis.WebSocket = RealWebSocket;
    vi.stubGlobal('location', RealLocation);
    expect(received).toEqual(['open', { t: 'pong' }]);
    expect(closed).toEqual([{ code: 1000, reason: 'closed' }, { code: 1000, reason: 'closed' }]);
  });
});
