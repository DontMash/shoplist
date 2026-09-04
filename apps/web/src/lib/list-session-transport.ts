import { fetchList, type ListResponse } from './api';

export type OperationKind =
  | 'item:add'
  | 'item:update'
  | 'item:delete'
  | 'list:clear'
  | 'list:rename'
  | 'list:delete';

export interface ClientOperation {
  operationId: string;
  kind: OperationKind;
  payload: Record<string, unknown>;
}

export interface SessionConnectionHandlers {
  onOpen: () => void;
  onMessage: (message: unknown) => void;
  onClose: (info?: { code?: number; reason?: string }) => void;
}

export interface SessionConnection {
  send(operation: ClientOperation): void;
  close(): void;
}

export interface SessionConnectionOptions extends SessionConnectionHandlers {
  listId: string;
  clientId: string;
  name: string;
}

/** Transport seam used by the list session. It is deliberately independent of WebSocket. */
export interface ListSessionTransport {
  fetchSnapshot(listId: string, signal?: AbortSignal): Promise<ListResponse>;
  connect(options: SessionConnectionOptions): SessionConnection;
}

/** Browser implementation of the list session transport. */
export const browserListSessionTransport: ListSessionTransport = {
  fetchSnapshot: fetchList,
  connect(options) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${scheme}://${location.host}/ws?list=${encodeURIComponent(options.listId)}` +
      `&client=${encodeURIComponent(options.clientId)}&name=${encodeURIComponent(options.name || 'Guest')}`,
    );
    socket.onopen = options.onOpen;
    socket.onmessage = (event) => {
      try {
        options.onMessage(JSON.parse(String(event.data)));
      } catch {
        // Malformed server data cannot be allowed to break the list session.
      }
    };
    socket.onclose = (event) => options.onClose({ code: event.code, reason: event.reason });
    socket.onerror = () => {
      try { socket.close(); } catch { /* noop */ }
    };
    return {
      send(operation) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open');
        socket.send(JSON.stringify(toWireOperation(operation)));
      },
      close() {
        try { socket.close(); } catch { /* noop */ }
      },
    };
  },
};

function toWireOperation(operation: ClientOperation): Record<string, unknown> {
  const { operationId: opId, kind, payload } = operation;
  switch (kind) {
    case 'item:add':
      return { t: kind, opId, tempId: payload.tempItemId, item: { name: payload.name, amount: payload.amount } };
    case 'item:update':
      return { t: kind, opId, id: payload.id, patch: payload.patch };
    case 'item:delete':
      return { t: kind, opId, id: payload.id };
    case 'list:rename':
      return { t: kind, opId, name: payload.name };
    case 'list:delete':
      return { t: kind, opId, ownerToken: payload.ownerToken };
    case 'list:clear':
      return { t: kind, opId };
  }
}
