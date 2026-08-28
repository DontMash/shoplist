import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button';
import { Input } from '../src/components/ui/input';

describe('UI primitives', () => {
  it('applies the shared button variant classes', () => {
    render(<Button variant="primary">Create list</Button>);
    expect(screen.getByRole('button', { name: 'Create list' })).toHaveClass('btn', 'btn-primary');
  });

  it('keeps the input accessible and applies the shared input class', () => {
    render(<Input aria-label="List name" placeholder="Weekly groceries" />);
    expect(screen.getByRole('textbox', { name: 'List name' })).toHaveClass('txt');
  });
});
