import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button';
import { Field } from '../src/components/ui/field';
import { Input } from '../src/components/ui/input';
import { FieldError } from '../src/components/shared/field-error';
import { ICONS } from '../src/components/shared/icon';

describe('UI primitives', () => {
  it('applies the shared button variant classes', () => {
    render(<Button variant="primary">Create list</Button>);
    expect(screen.getByRole('button', { name: 'Create list' })).toHaveClass('btn', 'btn-primary');
  });

  it('keeps the input accessible and applies the shared input class', () => {
    render(<Input aria-label="List name" placeholder="Weekly groceries" />);
    expect(screen.getByRole('textbox', { name: 'List name' })).toHaveClass('txt');
  });

  it('keeps a reserved error slot when a field is valid', () => {
    render(
      <Field>
        <Input aria-label="List name" />
        <FieldError field={{ state: { meta: { errors: [] } } }} />
      </Field>,
    );

    expect(document.querySelector('.form-error')).toHaveClass('form-error-reserved');
  });

  it('exposes only the shopping cart icon', () => {
    expect(ICONS).not.toHaveProperty('basket');
  });
});
