import { create } from 'zustand';
import { SORT_VALUES, type ListPreferences, type SortValue } from '../lib/list';
import { readStorage, writeStorage } from './storage';

export const DEFAULT_LIST_PREFERENCES: ListPreferences = {
  sort: 'created-asc',
  groupCollected: true,
};

type StoredPreferences = Partial<Record<string, Partial<ListPreferences>>>;

interface PreferencesStore {
  preferences: Record<string, ListPreferences>;
  setPreferences: (listId: string, preferences: ListPreferences) => void;
  updatePreferences: (listId: string, update: Partial<ListPreferences>) => void;
  removePreferences: (listId: string) => void;
}

function normalizePreferences(value: unknown): ListPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_LIST_PREFERENCES };
  const candidate = value as Partial<ListPreferences>;
  const sort: SortValue = typeof candidate.sort === 'string' && SORT_VALUES.has(candidate.sort)
    ? candidate.sort as SortValue
    : DEFAULT_LIST_PREFERENCES.sort;
  return {
    sort,
    groupCollected: candidate.groupCollected !== false,
  };
}

function initialPreferences(): Record<string, ListPreferences> {
  const stored = readStorage<unknown>('sl.listPrefs', {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored as StoredPreferences).map(([id, value]) => [id, normalizePreferences(value)]));
}

function persist(preferences: Record<string, ListPreferences>): void {
  writeStorage('sl.listPrefs', preferences);
}

export const usePreferencesStore = create<PreferencesStore>((set) => ({
  preferences: initialPreferences(),
  setPreferences: (listId, preferences) => set((state) => {
    const next = { ...state.preferences, [listId]: preferences };
    persist(next);
    return { preferences: next };
  }),
  updatePreferences: (listId, update) => set((state) => {
    const next = {
      ...state.preferences,
      [listId]: { ...(state.preferences[listId] || DEFAULT_LIST_PREFERENCES), ...update },
    };
    persist(next);
    return { preferences: next };
  }),
  removePreferences: (listId) => set((state) => {
    const next = { ...state.preferences };
    delete next[listId];
    persist(next);
    return { preferences: next };
  }),
}));
