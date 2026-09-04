import { Button } from '../ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';
import { Icon } from '../shared/icon';
import type { ShareDialogPayload } from '../../stores/dialog-store';
import { Modal } from './modal';
import { notify } from '../notification-toaster';

export function ShareDialog({ payload, close }: { payload: ShareDialogPayload; close: () => void }) {
  const url = `${window.location.origin}/#/join/${payload.list.id}`;

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      notify('Link copied');
    } catch {
      notify('Copy failed — select the link manually');
    }
  };

  const share = async () => {
    try {
      await navigator.share({
        title: payload.list.name,
        text: `Join my shopping list “${payload.list.name}”`,
        url,
      });
    } catch {
      notify('Share failed — copy the invite link instead.');
    }
  };

  return (
    <Modal
      title="Invite people"
      onOpenChange={(open) => { if (!open) close(); }}
      actions={[{ label: 'Done', onClick: close }]}
    >
      <div className="qr"><img src={`/api/qr?data=${encodeURIComponent(url)}`} alt="QR code with the invite link" /></div>
      <InputGroup className="share-link">
        <InputGroupInput readOnly value={url} aria-label="Invite link" />
        <InputGroupAddon align="inline-end" className="pr-1.5">
          <InputGroupButton type="button" variant="ghost" size="icon-sm" aria-label="Copy invite link" onClick={() => { void copy(); }}>
            <Icon name="copy" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {typeof navigator.share === 'function' && (
        <Button variant="primary" className="wide mt-2.5 w-full" onClick={() => { void share(); }}>
          Share link…
        </Button>
      )}
      <p className="hint muted">Anyone with this link or QR code can open this list and shop along — no account needed. Keep it private like a key.</p>
    </Modal>
  );
}
