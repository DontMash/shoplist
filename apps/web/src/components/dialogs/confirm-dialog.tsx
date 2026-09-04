import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import type { ConfirmDialogPayload } from '../../stores/dialog-store';

export function ConfirmDialog({ payload, close }: { payload: ConfirmDialogPayload; close: () => void }) {
  const confirm = () => {
    void payload.onConfirm?.();
    close();
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{payload.title}</AlertDialogTitle>
          <AlertDialogDescription>{payload.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={payload.danger ? 'danger' : 'primary'} onClick={confirm}>
            {payload.confirmLabel || 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
