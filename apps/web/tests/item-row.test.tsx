import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemRow } from '../src/components/list/item-row';
import type { ListSession } from '../src/lib/list-session';

const { interactMock, draggableMock } = vi.hoisted(() => ({
  interactMock: vi.fn(),
  draggableMock: vi.fn(),
}));

vi.mock('interactjs', () => ({
  default: interactMock,
}));

const item = { id: 'item-1', name: 'Milk', amount: '', collected: false };
const session = {
  updateItem: vi.fn(),
  collectItem: vi.fn(),
} as unknown as ListSession;

function setPointerCapability(coarse: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: coarse,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  });
}

describe('item touch interaction boundary', () => {
  beforeEach(() => {
    interactMock.mockReset();
    draggableMock.mockReset();
    draggableMock.mockReturnValue({ unset: vi.fn() });
    interactMock.mockReturnValue({ preventDefault: () => ({ draggable: draggableMock }) });
  });

  it('installs swipe behavior for coarse pointers', async () => {
    setPointerCapability(true);
    render(<ItemRow item={item} session={session} askDelete={vi.fn()} />);
    await waitFor(() => expect(draggableMock).toHaveBeenCalledOnce());
  });

  it('leaves desktop pointer dragging to the browser', async () => {
    setPointerCapability(false);
    render(<ItemRow item={item} session={session} askDelete={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interactMock).not.toHaveBeenCalled();
  });
});
