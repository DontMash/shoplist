import { useDialogStore } from '../stores/dialog-store';
import { ConfirmDialog } from './dialogs/confirm-dialog';
import { MenuDialog } from './dialogs/menu-dialog';
import { PromptDialog } from './dialogs/prompt-dialog';
import { ShareDialog } from './dialogs/share-dialog';
import { SortDialog } from './dialogs/sort-dialog';

export function DialogHost() {
  const dialog = useDialogStore((state) => state.dialog);
  const close = useDialogStore((state) => state.closeDialog);
  if (!dialog) return null;

  switch (dialog.type) {
    case 'prompt': return <PromptDialog payload={dialog.payload} close={close} />;
    case 'confirm': return <ConfirmDialog payload={dialog.payload} close={close} />;
    case 'menu': return <MenuDialog payload={dialog.payload} close={close} />;
    case 'share': return <ShareDialog payload={dialog.payload} close={close} />;
    case 'sort': return <SortDialog payload={dialog.payload} close={close} />;
  }
}
