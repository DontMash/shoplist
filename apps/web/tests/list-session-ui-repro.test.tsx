import { useSyncExternalStore } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createListSession, InMemoryListSessionTransport } from '../src/lib/list-session';

const snapshot = {
  list: { id: 'list', name: 'Groceries', createdAt: 1, revision: 0 },
  items: [],
  memberCount: 1,
};

describe('list page snapshot subscription repro', () => {
  it('does not throw when React invokes the session snapshot getter', () => {
    const session = createListSession({
      listId: 'list',
      clientId: 'client-a',
      transport: new InMemoryListSessionTransport(snapshot),
      autoStart: false,
    });

    function Probe() {
      const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
      return <output>{state.list?.name}</output>;
    }

    expect(() => render(<Probe />)).not.toThrow();
    session.close();
  });
});
