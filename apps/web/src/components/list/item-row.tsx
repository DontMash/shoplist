import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import interact from 'interactjs';
import { cn } from '../../lib/utils';
import type { ListItem } from '../../lib/list';
import type { ListSession } from '../../lib/list-session';
import { itemEditSchema } from '../../lib/schemas';
import { useCoarsePointer } from '../../hooks/use-coarse-pointer';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { FieldError } from '../shared/field-error';
import { Icon } from '../shared/icon';

interface ItemRowProps {
  item: ListItem;
  session: ListSession;
  askDelete: (item: ListItem) => void;
}

type EditableField = 'name' | 'amount';

type PendingValues = Record<EditableField, string | null>;
type Timers = Record<EditableField, ReturnType<typeof setTimeout> | undefined>;

export function ItemRow({ item, session, askDelete }: ItemRowProps) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const offsetRef = useRef(0);
  const timers = useRef<Timers>({ name: undefined, amount: undefined });
  const pending = useRef<PendingValues>({ name: null, amount: null });
  const collectRef = useRef<() => void>(() => undefined);
  const removeRef = useRef<() => void>(() => undefined);
  const swipeEnabled = useCoarsePointer();
  const itemForm = useForm({
    defaultValues: { name: item.name, amount: item.amount || '' },
    validators: { onChange: itemEditSchema },
  });

  useEffect(() => {
    if (pending.current.name === item.name) pending.current.name = null;
    if (pending.current.amount === (item.amount || '')) pending.current.amount = null;
    if (pending.current.name === null && itemForm.getFieldValue('name') !== item.name) itemForm.setFieldValue('name', item.name);
    if (pending.current.amount === null && itemForm.getFieldValue('amount') !== (item.amount || '')) itemForm.setFieldValue('amount', item.amount || '');
  }, [item.amount, item.name, itemForm]);

  useEffect(() => () => {
    Object.values(timers.current).forEach((timer) => { if (timer) clearTimeout(timer); });
  }, []);

  const commit = (field: EditableField) => {
    const value = String(itemForm.getFieldValue(field) || '').trim();
    const current = field === 'name' ? item.name : (item.amount || '');
    if (field === 'name' && !value) {
      pending.current.name = null;
      itemForm.setFieldValue('name', item.name);
      return;
    }
    if (value !== current) {
      pending.current[field] = value;
      session.updateItem(item.id, { [field]: value });
    } else {
      pending.current[field] = null;
    }
  };

  const schedule = (field: EditableField) => {
    const timer = timers.current[field];
    if (timer) clearTimeout(timer);
    timers.current[field] = setTimeout(() => commit(field), 350);
  };

  const resetSwipe = () => {
    offsetRef.current = 0;
    setOffset(0);
    setSwiping(false);
  };

  const collect = () => {
    session.collectItem(item.id, !item.collected);
    resetSwipe();
  };

  const remove = () => {
    resetSwipe();
    askDelete(item);
  };

  collectRef.current = collect;
  removeRef.current = remove;

  useEffect(() => {
    const row = rowRef.current;
    if (!swipeEnabled || !row) return undefined;

    const interactable = interact(row).preventDefault('auto').draggable({
      startAxis: 'x',
      lockAxis: 'x',
      ignoreFrom: 'button, input',
      onstart: () => {
        offsetRef.current = 0;
        setOffset(0);
        setSwiping(true);
      },
      onmove: (event) => {
        const next = Math.max(-112, Math.min(112, event.clientX - event.clientX0));
        offsetRef.current = next;
        setOffset(next);
      },
      onend: () => {
        if (offsetRef.current >= 100) collectRef.current();
        else if (offsetRef.current <= -100) removeRef.current();
        else resetSwipe();
      },
    });

    return () => interactable.unset();
  }, [swipeEnabled]);

  return (
    <li ref={rowRef} className={cn('item', item.collected && 'collected', swiping && 'swiping')} data-id={item.id}>
      <div className="item-swipe">
        <button type="button" className="swipe-action swipe-collect" onClick={collect}><Icon name="check" /><span>Collect</span></button>
        <button type="button" className="swipe-action swipe-delete" onClick={remove}><Icon name="trash" /><span>Delete</span></button>
        <div className="item-content" style={{ transform: `translateX(${offset}px)` }}>
          <div className="item-row1">
            <itemForm.Field name="name">
              {(field) => (
                <Field className="field-control item-field item-name-field" data-invalid={field.state.meta.errors.length > 0}>
                  <Input
                    className="item-name"
                    value={field.state.value}
                    onChange={(event) => { pending.current.name = event.target.value; field.handleChange(event.target.value); schedule('name'); }}
                    onBlur={() => { field.handleBlur(); const timer = timers.current.name; if (timer) clearTimeout(timer); commit('name'); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                    maxLength={80}
                    aria-label="Item name"
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldError field={field} />
                </Field>
              )}
            </itemForm.Field>
            <itemForm.Field name="amount">
              {(field) => (
                <Field className="field-control item-field item-amount-field" data-invalid={field.state.meta.errors.length > 0}>
                  <Input
                    className="item-amount"
                    value={field.state.value}
                    onChange={(event) => { pending.current.amount = event.target.value; field.handleChange(event.target.value); schedule('amount'); }}
                    onBlur={() => { field.handleBlur(); const timer = timers.current.amount; if (timer) clearTimeout(timer); commit('amount'); }}
                    maxLength={40}
                    placeholder="qty"
                    aria-label="Amount"
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldError field={field} />
                </Field>
              )}
            </itemForm.Field>
          </div>
          <div className="item-row2">
            <button type="button" className="chip chip-collected" aria-pressed={!!item.collected} onClick={collect}><Icon name="check" /><span>Collected</span></button>
            <span className="spacer" />
            <Button type="button" variant="ghost" size="icon" className="icon-btn item-del" aria-label="Delete item" onClick={remove}><Icon name="trash" /></Button>
          </div>
        </div>
      </div>
    </li>
  );
}
