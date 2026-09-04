import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { DialogHost } from '../src/components/dialog-host';
import { HomePage } from '../src/pages/home-page';
import { JoinPage } from '../src/pages/join-page';
import { useNotificationStore } from '../src/stores/notification-store';
import { useParticipantStore } from '../src/stores/participant-store';
import { useSavedListsStore } from '../src/stores/saved-lists-store';

const listResponse = {
  list: { id: 'list-1', name: 'Groceries', createdAt: 1, revision: 0 },
  items: [{ id: 'item-1', name: 'Milk', amount: '2', collected: false, createdAt: 1 }],
  memberCount: 1,
};

function TestRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState('/');
  return <Router hook={() => [location, setLocation]}>{children}</Router>;
}

function renderPage(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><TestRouter><>{children}<DialogHost /></></TestRouter></QueryClientProvider>);
}

describe('home and join page boundaries', () => {
  beforeEach(() => {
    useSavedListsStore.setState({ lists: [] });
    useNotificationStore.setState({ notifications: [] });
  });

  it('shows saved list summaries and removes a gone list after confirmation', async () => {
    useSavedListsStore.setState({ lists: [{ id: 'list-1', name: 'Groceries', ownerToken: null, joinedAt: 1 }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    renderPage(<HomePage />);

    expect(await screen.findByText('This list was deleted or no longer exists — tap to remove it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Groceries/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(useSavedListsStore.getState().lists).toEqual([]);
  });

  it('creates a list and reports creation failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ list: { id: 'list-2', name: 'Trip', createdAt: 2, revision: 0 }, ownerToken: 'owner' }) });
    vi.stubGlobal('fetch', fetchMock);
    renderPage(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Create your first list' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New list' }), { target: { value: 'Trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create list' }));

    await waitFor(() => expect(useSavedListsStore.getState().lists[0]?.name).toBe('Trip'));

    cleanup();
    const failedFetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', failedFetch);
    useSavedListsStore.setState({ lists: [] });
    renderPage(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Create your first list' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New list' }), { target: { value: 'Fail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create list' }));
    await waitFor(() => expect(useNotificationStore.getState().notifications.at(-1)?.message).toContain('Could not create'));
  });

  it('joins a fetched list with a persisted display name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => listResponse }));
    useParticipantStore.setState({ identity: { clientId: 'client', name: '' } });
    renderPage(<JoinPage id="list-1" />);

    expect(await screen.findByRole('heading', { name: 'Join “Groceries”' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your name' }), { target: { value: 'Alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join list' }));
    await waitFor(() => expect(useSavedListsStore.getState().lists[0]).toMatchObject({ id: 'list-1', name: 'Groceries' }));
    expect(useParticipantStore.getState().identity.name).toBe('Alex');
  });

  it('explains an unavailable invite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    renderPage(<JoinPage id="missing" />);
    expect(await screen.findByText("This invite is not valid — the list doesn't exist (anymore).")) .toBeInTheDocument();
  });
});
