import { cn } from '../../lib/utils';
import { Icon } from '../shared/icon';
import type { MenuDialogPayload } from '../../stores/dialog-store';
import { Modal } from './modal';

export function MenuDialog({ payload, close }: { payload: MenuDialogPayload; close: () => void }) {
  const select = (action: MenuDialogPayload['actions'][number]) => {
    close();
    action.onSelect();
  };

  return (
    <Modal
      title={payload.title}
      onOpenChange={(open) => { if (!open) close(); }}
      actions={[{ label: 'Done', onClick: close }]}
    >
      <div className="menu-list">
        {payload.actions.map((action) => (
          <button
            type="button"
            className={cn('menu-item', action.danger && 'danger')}
            onClick={() => select(action)}
            key={action.label}
          >
            <Icon name={action.icon} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
