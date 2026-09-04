import { create } from 'zustand';
import { readStorage, writeStorage } from './storage';

export interface SavedListEntry {
  id: string;
  name: string;
  ownerToken: string | null;
  joinedAt: number;
}

type SavedListUpdate = SavedListEntry[] | ((entries: SavedListEntry[]) => SavedListEntry[]);

interface SavedListsStore {
  lists: SavedListEntry[];
  replaceLists: (update: SavedListUpdate) => void;
  upsertList: (entry: SavedListEntry) => void;
  removeList: (id: string) => void;
}

function normalizeEntry(value: unknown): SavedListEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string') return null;
  const ownerToken = entry.ownerToken === null || entry.ownerToken === undefined
    ? null
    : typeof entry.ownerToken === 'string' ? entry.ownerToken : null;
  const joinedAt = typeof entry.joinedAt === 'number' && Number.isFinite(entry.joinedAt)
    ? entry.joinedAt
    : 0;
  return { id: entry.id, name: entry.name, ownerToken, joinedAt };
}

function initialLists(): SavedListEntry[] {
  const stored = readStorage<unknown>('sl.lists', []);
  return Array.isArray(stored) ? stored.map(normalizeEntry).filter((entry): entry is SavedListEntry => entry !== null) : [];
}

function persist(lists: SavedListEntry[]): void {
  writeStorage('sl.lists', lists);
}

export const useSavedListsStore = create<SavedListsStore>((set) => ({
  lists: initialLists(),
  replaceLists: (update) => set((state) => {
    const lists = typeof update === 'function' ? update(state.lists) : update;
    persist(lists);
    return { lists };
  }),
  upsertList: (entry) => set((state) => {
    const lists = [entry, ...state.lists.filter((candidate) => candidate.id !== entry.id)];
    persist(lists);
    return { lists };
  }),
  removeList: (id) => set((state) => {
    const lists = state.lists.filter((entry) => entry.id !== id);
    persist(lists);
    return { lists };
  }),
}));

export type { SavedListUpdate };
