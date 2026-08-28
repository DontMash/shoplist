export const SORT_OPTIONS = [
  ['created-asc', 'Added first'],
  ['created-desc', 'Newest first'],
  ['name-asc', 'Name (A–Z)'],
  ['name-desc', 'Name (Z–A)'],
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number][0];

export const SORT_VALUES = new Set<string>(SORT_OPTIONS.map(([value]) => value));

export interface ListItem {
  id: string;
  name: string;
  amount?: string;
  collected?: boolean;
  createdAt?: number;
  updatedAt?: number;
  by?: string | null;
}

export interface ListPreferences {
  sort: SortValue;
  groupCollected: boolean;
}

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
};

export function initials(name: unknown): string {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0].toUpperCase())
    .join('') || '?';
}

export function extractListId(value: unknown): string | null {
  const text = String(value || '').trim();
  const match = text.match(/#\/(?:join|list)\/([A-Za-z0-9_-]{4,40})/);
  return match ? match[1] : (/^[A-Za-z0-9_-]{4,40}$/.test(text) ? text : null);
}

export function sortItems(items: ListItem[], preferences: ListPreferences): ListItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (preferences.groupCollected && Boolean(a.item.collected) !== Boolean(b.item.collected)) {
        return a.item.collected ? 1 : -1;
      }
      const order = preferences.sort === 'created-desc'
        ? (b.item.createdAt || 0) - (a.item.createdAt || 0)
        : preferences.sort === 'name-asc'
          ? String(a.item.name).localeCompare(String(b.item.name), undefined, { sensitivity: 'base' })
          : preferences.sort === 'name-desc'
            ? String(b.item.name).localeCompare(String(a.item.name), undefined, { sensitivity: 'base' })
            : (a.item.createdAt || 0) - (b.item.createdAt || 0);
      return order || a.index - b.index;
    })
    .map(({ item }) => item);
}
