import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { DialogHost } from '../src/components/dialog-host';
import { ListPage } from '../src/pages/list-page';
import { useParticipantStore } from '../src/stores/participant-store';
import { useSavedListsStore } from '../src/stores/saved-lists-store';

const snapshot = {
  list: { id: 'list-1', name: 'Groceries', createdAt: 1, revision: 0 },
  items: [{ id: 'item-1', name: 'Milk', amount: '2', collected: false, createdAt: 1, lastEditedBy: 'client-test' }],
  members: [{ clientId: 'client-test', name: 'Alex', color: '#123456' }],
  memberCount: 1,
};

class MockWebSocket {
  public static readonly OPEN = 1;
  public readonly readyState = MockWebSocket.OPEN;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public sent: string[] = [];

  public constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(): void {
    this.onclose?.({ code: 1000, reason: '' });
  }
}

function TestRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState('/list/list-1');
  return <Router hook={() => [location, setLocation]}>{children}</Router>;
}

/** Minimal oRPC fetch response for the native transport. */
function rpcResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ json: value }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestRouter><><ListPage id="list-1" /><DialogHost /></></TestRouter>
    </QueryClientProvider>,
  );
}

describe('list page boundary', () => {
  beforeEach(() => {
    useParticipantStore.setState({ identity: { clientId: 'client-test', name: 'Alex' } });
    useSavedListsStore.setState({ lists: [{ id: 'list-1', name: 'Groceries', ownerToken: null, joinedAt: 1 }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rpcResponse(snapshot)));
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the current list, adds an item, and collects an item', async () => {
    renderList();
    expect(await screen.findByDisplayValue('Milk')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'New item name' }), { target: { value: 'Bread' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByDisplayValue('Bread')).toBeInTheDocument();

    const breadRow = screen.getByDisplayValue('Bread').closest('li');
    if (!breadRow) throw new Error('Bread row is missing');
    fireEvent.click(within(breadRow).getByRole('button', { name: 'Collect', pressed: false }));
    await waitFor(() => expect(within(breadRow).getByRole('button', { name: 'Collected', pressed: true })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('renders the item editor as a name-only badge', async () => {
    renderList();
    expect(await screen.findByText('Alex')).toHaveClass('item-editor-badge');
  });

  it('keeps the add action aligned with the input row', async () => {
    renderList();
    expect(await screen.findByDisplayValue('Milk')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toHaveClass('add-btn-top-aligned');
  });

  it('confirms item deletion before removing an item', async () => {
    renderList();
    expect(await screen.findByDisplayValue('Milk')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete item' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByDisplayValue('Milk')).not.toBeInTheDocument());
  });

  it('mutes notifications from the list menu through the native transport', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      if (request.url.includes('/rpc/push/')) {
        const body = JSON.parse(await request.text()) as { json: { muted?: boolean } };
        return rpcResponse({
          enabled: true,
          muted: body.json.muted ?? false,
          available: true,
        });
      }
      return rpcResponse(snapshot);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderList();
    expect(await screen.findByDisplayValue('Milk')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'List options' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mute notifications' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[Request, RequestInit?]>;
      expect(calls.some((call) => call[0].url.includes('/rpc/push/mute'))).toBe(true);
      expect(calls.every((call) => !call[0].url.includes('/api/'))).toBe(true);
    });
  });
});
