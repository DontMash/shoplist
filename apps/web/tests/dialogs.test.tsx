import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/dialogs/confirm-dialog';
import { MenuDialog } from '../src/components/dialogs/menu-dialog';
import { PromptDialog } from '../src/components/dialogs/prompt-dialog';
import { ShareDialog } from '../src/components/dialogs/share-dialog';
import { SortDialog } from '../src/components/dialogs/sort-dialog';
import { DEFAULT_LIST_PREFERENCES } from '../src/stores/preferences-store';

const close = vi.fn();

describe('declarative dialogs', () => {
  it('validates and submits a prompt', async () => {
    const onConfirm = vi.fn();
    render(<PromptDialog payload={{ title: 'Rename', label: 'New name', value: 'Old', onConfirm }} close={close} />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('New name'));
  });

  it('confirms destructive actions and closes', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog payload={{ title: 'Delete?', body: 'Cannot undo', danger: true, onConfirm }} close={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });

  it('renders menu actions as an explicitly typed payload', () => {
    const onSelect = vi.fn();
    render(<MenuDialog payload={{ title: 'Options', actions: [{ label: 'Rename', icon: 'edit', onSelect }] }} close={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
  });

  it('applies sort and grouping preferences', async () => {
    const onApply = vi.fn();
    render(<SortDialog payload={{ preferences: DEFAULT_LIST_PREFERENCES, onApply }} close={close} />);
    const sortTrigger = screen.getByRole('combobox');
    expect(sortTrigger.tagName).not.toBe('SELECT');
    fireEvent.click(sortTrigger);
    await screen.findByRole('listbox');
    const selectPopup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
    expect(selectPopup).toHaveClass('z-[1101]');
    expect(selectPopup?.parentElement).toHaveClass('z-[1101]');
    const sortOption = await screen.findByRole('option', { name: 'Name (Z–A)' });
    fireEvent.pointerDown(sortOption, { button: 0, pointerType: 'mouse' });
    fireEvent.click(sortOption, { detail: 1 });
    expect(screen.getByRole('combobox')).toHaveTextContent('Name (Z–A)');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ sort: 'name-desc', groupCollected: false }));
  });

  it('does not add Base UI inline styles when opening the sort select', async () => {
    render(<SortDialog payload={{ preferences: DEFAULT_LIST_PREFERENCES, onApply: vi.fn() }} close={close} />);
    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');

    expect([...document.querySelectorAll('style')].some((style) => (
      style.textContent?.includes('.base-ui-disable-scrollbar')
    ))).toBe(false);
  });

  it('copies and shares an invite through the platform APIs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    render(<ShareDialog payload={{ list: { id: 'list-1', name: 'Groceries' } }} close={close} />);

    expect(document.querySelector('[data-slot="input-group-addon"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).not.toHaveClass('icon-btn');
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share link…' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/join/list-1`);
      expect(share).toHaveBeenCalled();
    });
  });
});
