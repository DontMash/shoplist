import { beforeEach, describe, expect, it } from 'vitest';
import { useDialogStore } from '../src/stores/dialog-store';
import { useNotificationStore } from '../src/stores/notification-store';
import { useParticipantStore } from '../src/stores/participant-store';
import { DEFAULT_LIST_PREFERENCES, usePreferencesStore } from '../src/stores/preferences-store';
import { useSavedListsStore, type SavedListEntry } from '../src/stores/saved-lists-store';

const entry: SavedListEntry = { id: 'list-1', name: 'Groceries', ownerToken: null, joinedAt: 1 };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  useParticipantStore.setState({ identity: { clientId: 'client', name: '' } });
  useSavedListsStore.setState({ lists: [] });
  usePreferencesStore.setState({ preferences: {} });
  useNotificationStore.setState({ notifications: [] });
  useDialogStore.getState().closeDialog();
});

describe('application stores', () => {
  it('persists participant names without replacing the participant identifier', () => {
    useParticipantStore.getState().setName('Alex');
    expect(useParticipantStore.getState().identity).toEqual({ clientId: 'client', name: 'Alex' });
    expect(JSON.parse(localStorage.getItem('sl.name') || 'null')).toBe('Alex');
    expect(JSON.parse(localStorage.getItem('sl.client') || 'null')).toBe('client');
  });

  it('updates saved list membership through typed actions', () => {
    useSavedListsStore.getState().upsertList(entry);
    useSavedListsStore.getState().upsertList({ ...entry, name: 'Weekly groceries' });
    useSavedListsStore.getState().replaceLists((lists) => [...lists, { ...entry, id: 'list-2' }]);
    expect(useSavedListsStore.getState().lists.map((list) => list.name)).toEqual(['Weekly groceries', 'Groceries']);
    useSavedListsStore.getState().removeList('list-1');
    expect(useSavedListsStore.getState().lists).toEqual([{ ...entry, id: 'list-2' }]);
  });

  it('persists and removes device-local list preferences', () => {
    usePreferencesStore.getState().updatePreferences('list-1', { sort: 'name-desc' });
    expect(usePreferencesStore.getState().preferences['list-1']).toEqual({ ...DEFAULT_LIST_PREFERENCES, sort: 'name-desc' });
    usePreferencesStore.getState().setPreferences('list-1', { sort: 'created-desc', groupCollected: false });
    expect(usePreferencesStore.getState().preferences['list-1'].groupCollected).toBe(false);
    usePreferencesStore.getState().removePreferences('list-1');
    expect(usePreferencesStore.getState().preferences['list-1']).toBeUndefined();
  });

  it('keeps one typed dialog payload at a time', () => {
    useDialogStore.getState().openPrompt({ title: 'Name', label: 'Your name', onConfirm: () => undefined });
    expect(useDialogStore.getState().dialog?.type).toBe('prompt');
    useDialogStore.getState().openConfirm({ title: 'Confirm', body: 'Continue?' });
    expect(useDialogStore.getState().dialog).toEqual({ type: 'confirm', payload: { title: 'Confirm', body: 'Continue?' } });
    useDialogStore.getState().openMenu({ title: 'Options', actions: [] });
    expect(useDialogStore.getState().dialog?.type).toBe('menu');
    useDialogStore.getState().openShare({ list: { id: 'list-1', name: 'Groceries' } });
    expect(useDialogStore.getState().dialog?.type).toBe('share');
    useDialogStore.getState().openSort({ preferences: DEFAULT_LIST_PREFERENCES, onApply: () => undefined });
    expect(useDialogStore.getState().dialog?.type).toBe('sort');
    useDialogStore.getState().closeDialog();
    expect(useDialogStore.getState().dialog).toBeNull();
  });

  it('queues and dismisses notifications', () => {
    const id = useNotificationStore.getState().addNotification('Saved');
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    useNotificationStore.getState().dismissNotification(id);
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });
});
