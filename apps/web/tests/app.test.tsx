import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { App } from '../src/app';
import { toast } from '../src/components/ui/toast';
import { notify } from '../src/components/notification-toaster';
import { useDialogStore } from '../src/stores/dialog-store';
import { useNotificationStore } from '../src/stores/notification-store';
import { useParticipantStore } from '../src/stores/participant-store';
import { useSavedListsStore } from '../src/stores/saved-lists-store';

function TestRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState('/');
  return (
    <>
      <button type="button" data-testid="navigate-away" onClick={() => setLocation('/join/abcd')}>Navigate</button>
      <Router hook={() => [location, setLocation]}>{children}</Router>
    </>
  );
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestRouter>
        <App />
      </TestRouter>
    </QueryClientProvider>,
  );
}

describe('application boundary', () => {
  beforeEach(() => {
    useParticipantStore.setState({ identity: { clientId: 'client-test', name: '' } });
    useSavedListsStore.setState({ lists: [] });
    useDialogStore.getState().closeDialog();
    useNotificationStore.setState({ notifications: [] });
    toast.close();
  });

  afterEach(() => {
    toast.close();
    vi.restoreAllMocks();
  });

  it('renders the home route and opens the named-list dialog', async () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Shoplist' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create your first list' }));

    expect(screen.getByRole('heading', { name: 'New list' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New list' })).toBeInTheDocument();
  });

  it('validates invite input at the rendered home boundary', async () => {
    renderApp();
    const invite = screen.getByRole('textbox', { name: 'Invite link or code' });

    fireEvent.change(invite, { target: { value: 'not an invite' } });
    fireEvent.blur(invite);

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid invite link or code');
  });

  it('queues accessible transient feedback and dismisses it after its duration', async () => {
    vi.useFakeTimers();
    renderApp();
    act(() => {
      notify('First feedback');
      notify('Second feedback');
    });

    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('First feedback')).toBeInTheDocument();
    expect(screen.getByText('Second feedback')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3600); });
    expect(screen.queryByText('First feedback')).not.toBeInTheDocument();
    expect(screen.queryByText('Second feedback')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps notifications above an open dialog', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Create your first list' }));

    act(() => notify('Visible feedback'));

    const notifications = screen.getByRole('region', { name: 'Notifications' });
    expect(notifications).toHaveClass('z-[1100]');
    expect(notifications).not.toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Visible feedback')).toBeInTheDocument();
  });

  it('closes a dialog when the route changes', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Create your first list' }));
    expect(screen.getByRole('heading', { name: 'New list' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('navigate-away'));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New list' })).not.toBeInTheDocument());
  });
});
