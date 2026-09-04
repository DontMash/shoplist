import { useForm } from '@tanstack/react-form';
import { SORT_OPTIONS } from '../../lib/list';
import { Field, FieldGroup } from '../ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { preferencesSchema } from '../../lib/schemas';
import type { SortDialogPayload } from '../../stores/dialog-store';
import { Modal } from './modal';

export function SortDialog({ payload, close }: { payload: SortDialogPayload; close: () => void }) {
  const form = useForm({
    defaultValues: payload.preferences,
    validators: { onSubmit: preferencesSchema },
    onSubmit: ({ value }) => {
      payload.onApply(value);
      close();
    },
  });

  return (
    <Modal
      title="Sort items"
      onOpenChange={(open) => { if (!open) close(); }}
      actions={[
        { label: 'Cancel', onClick: close },
        { label: 'Apply', kind: 'primary', onClick: () => { void form.handleSubmit(); } },
      ]}
    >
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <FieldGroup className="contents">
        <div className="sort-settings">
          <form.Field name="sort">
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0}>
              <div className="setting">
                <span id="sort-items-label">Sort items by</span>
                <Select
                  items={SORT_OPTIONS.map(([value, label]) => ({ value, label }))}
                  value={field.state.value}
                  onValueChange={(value) => { if (value) field.handleChange(value as typeof field.state.value); }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-labelledby="sort-items-label"
                    aria-invalid={field.state.meta.errors.length > 0}
                    onBlur={field.handleBlur}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SORT_OPTIONS.map(([value, label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              </Field>
            )}
          </form.Field>
          <form.Field name="groupCollected">
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0}>
              <label className="setting-check">
                <input type="checkbox" aria-invalid={field.state.meta.errors.length > 0} checked={field.state.value} onChange={(event) => field.handleChange(event.target.checked)} onBlur={field.handleBlur} />
                <span>Group collected items at the bottom</span>
              </label>
              </Field>
            )}
          </form.Field>
          <p className="hint muted">These display settings are saved on this device only.</p>
        </div>
        </FieldGroup>
      </form>
    </Modal>
  );
}
