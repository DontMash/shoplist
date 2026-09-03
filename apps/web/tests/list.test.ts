import { describe, expect, it, vi } from 'vitest';
import { extractListId, initials, sortItems, uid, type ListItem } from '../src/lib/list';
import { cn } from '../src/lib/utils';

describe('frontend helpers', () => {
  it('extracts only valid list ids from invite links or codes', () => {
    expect(extractListId('https://example.test/#/join/abcd_123')).toBe('abcd_123');
    expect(extractListId('https://example.test/#/list/abcd_123')).toBe('abcd_123');
    expect(extractListId('#/join/abcd_123')).toBe('abcd_123');
    expect(extractListId('/#/join/abcd_123')).toBe('abcd_123');
    expect(extractListId('abcd-123')).toBe('abcd-123');
    expect(extractListId('short')).toBe('short');
    expect(extractListId('https://example.test/#/join/no')).toBeNull();
    expect(extractListId('https://example.test/#/join/abcd_123/extra')).toBeNull();
    expect(extractListId('https://example.test/#/join/abcd_123?unexpected=true')).toBeNull();
    expect(extractListId('prefix https://example.test/#/join/abcd_123 suffix')).toBeNull();
    expect(extractListId('not an invite')).toBeNull();
    expect(extractListId(null)).toBeNull();
  });

  it('creates readable initials and combines class names', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  single  ')).toBe('S');
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials(null)).toBe('?');
    expect(cn('btn', false, ['wide', null], undefined)).toBe('btn wide');
  });

  it('uses Web Crypto when available and falls back when it is not', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-id' });
    expect(uid()).toBe('fixed-id');
    vi.stubGlobal('crypto', {});
    const id = uid();
    expect(id).toMatch(/^[a-z0-9]+$/);
    vi.unstubAllGlobals();
  });

  it('groups collected items and keeps sorting stable', () => {
    const items: ListItem[] = [
      { id: 'a', name: 'Bananas', createdAt: 1, collected: true },
      { id: 'b', name: 'Apples', createdAt: 2, collected: false },
      { id: 'c', name: 'Carrots', createdAt: 2, collected: false },
    ];
    expect(sortItems(items, { sort: 'created-asc', groupCollected: true }).map((item) => item.id))
      .toEqual(['b', 'c', 'a']);
    expect(sortItems(items, { sort: 'created-desc', groupCollected: false }).map((item) => item.id))
      .toEqual(['b', 'c', 'a']);
    expect(sortItems([{ id: 'new', name: 'New' }, { id: 'old', name: 'Old', createdAt: 1 }],
      { sort: 'created-desc', groupCollected: false }).map((item) => item.id))
      .toEqual(['old', 'new']);
    expect(sortItems([{ id: 'open', name: 'Open', collected: false }, { id: 'done', name: 'Done', collected: true }],
      { sort: 'created-asc', groupCollected: true }).map((item) => item.id))
      .toEqual(['open', 'done']);
    expect(sortItems(items, { sort: 'name-asc', groupCollected: false }).map((item) => item.name))
      .toEqual(['Apples', 'Bananas', 'Carrots']);
    expect(sortItems(items, { sort: 'name-desc', groupCollected: false }).map((item) => item.name))
      .toEqual(['Carrots', 'Bananas', 'Apples']);
    expect(sortItems([
      { id: 'first', name: 'Same' },
      { id: 'second', name: 'same' },
    ], { sort: 'created-asc', groupCollected: false }).map((item) => item.id))
      .toEqual(['first', 'second']);
  });
});
