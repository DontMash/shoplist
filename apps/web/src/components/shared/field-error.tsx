interface FieldWithErrors {
  state: {
    meta: {
      errors: unknown[];
    };
  };
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function FieldError({ field }: { field: FieldWithErrors }) {
  const errors = field.state.meta.errors;
  const message = errors.map(errorMessage).join(', ');

  return (
    <span
      className="form-error form-error-reserved"
      role={errors.length ? 'alert' : undefined}
      aria-hidden={!errors.length || undefined}
    >
      {message}
    </span>
  );
}
