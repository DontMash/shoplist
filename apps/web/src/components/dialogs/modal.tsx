import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog';

export interface ModalAction {
  label: string;
  kind?: 'ghost' | 'primary' | 'danger';
  onClick: () => void;
}

interface ModalProps {
  title: string;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  actions?: ModalAction[];
}

export function Modal({
  title,
  open = true,
  onOpenChange,
  children,
  actions = [{ label: 'OK', onClick: () => onOpenChange(false) }],
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,400px)] max-h-[min(90dvh,700px)] overflow-auto rounded-[18px] p-0 shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
      >
        <div className="p-5">
          <DialogTitle className="mb-2 text-[1.1rem] leading-tight font-semibold">{title}</DialogTitle>
          <div className="[&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted-foreground">{children}</div>
          <DialogFooter className="mt-[18px] flex-row flex-wrap justify-end gap-2">
            {actions.map((action) => (
              <Button
                key={action.label}
                type="button"
                variant={action.kind || 'ghost'}
                className="min-h-11 rounded-xl px-4"
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
