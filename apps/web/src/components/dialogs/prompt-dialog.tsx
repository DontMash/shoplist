import { useForm } from '@tanstack/react-form';
import { Field, FieldGroup } from '../ui/field';
import { Input } from '../ui/input';
import { FieldError } from '../shared/field-error';
import { listNameSchema, promptSchema } from '../../lib/schemas';
import type { PromptDialogPayload } from '../../stores/dialog-store';
import { Modal } from './modal';

export function PromptDialog({ payload, close }: { payload: PromptDialogPayload; close: () => void }) {
  const validationSchema = payload.validation === 'list-name'
    ? listNameSchema
    : promptSchema(payload.maxLength ?? 60);
  const form = useForm({
    defaultValues: { value: payload.value || '' },
    validators: { onChange: validationSchema, onSubmit: validationSchema },
    onSubmit: async ({ value }) => {
      await payload.onConfirm(value.value.trim());
      close();
    },
  });

  return (
    <Modal
      title={payload.title}
      onOpenChange={(open) => { if (!open) close(); }}
      actions={[
        { label: 'Cancel', onClick: close },
        { label: payload.confirmLabel || 'Save', kind: 'primary', onClick: () => { void form.handleSubmit(); } },
      ]}
    >
      <p>{payload.label}</p>
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <FieldGroup className="contents">
        <form.Field name="value">
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <Input
                className="mt-2.5"
                autoFocus
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder={payload.placeholder}
                maxLength={payload.maxLength ?? 60}
                aria-label={payload.title}
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldError field={field} />
            </Field>
          )}
        </form.Field>
        </FieldGroup>
      </form>
    </Modal>
  );
}
