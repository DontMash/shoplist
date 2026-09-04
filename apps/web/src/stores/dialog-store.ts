import { create } from 'zustand';
import type { ListPreferences } from '../lib/list';
import type { IconName } from '../components/shared/icon';

export interface PromptDialogPayload {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  validation?: 'prompt' | 'list-name';
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
}

export interface ConfirmDialogPayload {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => void | Promise<void>;
}

export interface MenuDialogAction {
  label: string;
  icon: IconName;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuDialogPayload {
  title: string;
  actions: MenuDialogAction[];
}

export interface ShareDialogPayload {
  list: { id: string; name: string };
}

export interface SortDialogPayload {
  preferences: ListPreferences;
  onApply: (preferences: ListPreferences) => void;
}

export type DialogState =
  | { type: 'prompt'; payload: PromptDialogPayload }
  | { type: 'confirm'; payload: ConfirmDialogPayload }
  | { type: 'menu'; payload: MenuDialogPayload }
  | { type: 'share'; payload: ShareDialogPayload }
  | { type: 'sort'; payload: SortDialogPayload }
  | null;

interface DialogStore {
  dialog: DialogState;
  openPrompt: (payload: PromptDialogPayload) => void;
  openConfirm: (payload: ConfirmDialogPayload) => void;
  openMenu: (payload: MenuDialogPayload) => void;
  openShare: (payload: ShareDialogPayload) => void;
  openSort: (payload: SortDialogPayload) => void;
  closeDialog: () => void;
}

export const useDialogStore = create<DialogStore>((set) => ({
  dialog: null,
  openPrompt: (payload) => set({ dialog: { type: 'prompt', payload } }),
  openConfirm: (payload) => set({ dialog: { type: 'confirm', payload } }),
  openMenu: (payload) => set({ dialog: { type: 'menu', payload } }),
  openShare: (payload) => set({ dialog: { type: 'share', payload } }),
  openSort: (payload) => set({ dialog: { type: 'sort', payload } }),
  closeDialog: () => set({ dialog: null }),
}));
