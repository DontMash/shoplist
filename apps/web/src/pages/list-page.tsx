import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Link, useLocation } from 'wouter';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Field, FieldGroup } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { FieldError } from '../components/shared/field-error';
import { Icon } from '../components/shared/icon';
import { ItemRow } from '../components/list/item-row';
import { useDialogStore } from '../stores/dialog-store';
import { DEFAULT_LIST_PREFERENCES, usePreferencesStore } from '../stores/preferences-store';
import { useParticipantStore } from '../stores/participant-store';
import { useSavedListsStore } from '../stores/saved-lists-store';
import { notify } from '../components/notification-toaster';
import { getListSessionCollection, createListSession, type SessionStatus } from '../lib/list-session';
import { listQueryKey } from '../lib/api';
import { initials, sortItems, type ListItem, type ListPreferences } from '../lib/list';
import { itemSchema } from '../lib/schemas';

function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'live': return 'Live';
    case 'connecting': return 'Connecting';
    case 'reconnecting': return 'Reconnecting';
    case 'offline': return 'Offline';
    case 'missing': return 'List missing';
    case 'deleted': return 'List deleted';
    case 'closed': return 'Closed';
  }
}

const SESSION_STATUS_CLASSES: Record<SessionStatus, string> = {
  connecting: 'status-connecting',
  live: 'status-live',
  reconnecting: 'status-reconnecting',
  offline: 'status-offline',
  missing: 'status-missing',
  deleted: 'status-deleted',
  closed: 'status-closed',
};

function sessionStatusClass(status: SessionStatus): string {
  return SESSION_STATUS_CLASSES[status];
}

function sessionDotClass(status: SessionStatus): string {
  if (status === 'live') return 'live';
  if (status === 'missing' || status === 'deleted') return 'missing';
  if (status === 'offline') return 'offline';
  return 'connecting';
}

export function ListPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const identity = useParticipantStore((state) => state.identity);
  const entry = useSavedListsStore((state) => state.lists.find((item) => item.id === id));
  const replaceLists = useSavedListsStore((state) => state.replaceLists);
  const removeList = useSavedListsStore((state) => state.removeList);
  const setPreferences = usePreferencesStore((state) => state.setPreferences);
  const storedPreferences = usePreferencesStore((state) => state.preferences[id]);
  const preferences = storedPreferences || DEFAULT_LIST_PREFERENCES;
  const openConfirm = useDialogStore((state) => state.openConfirm);
  const openPrompt = useDialogStore((state) => state.openPrompt);
  const openMenuDialog = useDialogStore((state) => state.openMenu);
  const openShare = useDialogStore((state) => state.openShare);
  const openSort = useDialogStore((state) => state.openSort);
  const addNameRef = useRef<HTMLInputElement>(null);
  const terminalHandled = useRef(false);
  const outcomeHandled = useRef<string | null>(null);

  const session = useMemo(() => createListSession({
    listId: id,
    clientId: identity.clientId,
    name: identity.name,
    ownerToken: entry?.ownerToken,
    queryClient,
  }), [entry?.ownerToken, id, identity.clientId, identity.name, queryClient]);
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const liveItems = useLiveQuery(getListSessionCollection(session));
  const collectionItems: ListItem[] = liveItems.data as ListItem[];
  const list = sessionState.list
    ? {
        ...sessionState.list,
        items: sessionState.items.map((item) => collectionItems.find((candidate) => candidate.id === item.id) || item),
      }
    : null;

  const forgetList = useCallback((removePreferences = false) => {
    queryClient.removeQueries({ queryKey: listQueryKey(id) });
    removeList(id);
    if (removePreferences) usePreferencesStore.getState().removePreferences(id);
  }, [id, queryClient, removeList]);

  useEffect(() => () => session.close(), [session]);
  useEffect(() => {
    const onlineHandler = () => session.kick();
    window.addEventListener('online', onlineHandler);
    return () => window.removeEventListener('online', onlineHandler);
  }, [session]);
  useEffect(() => {
    const outcome = sessionState.outcome;
    if (!outcome || outcome.kind !== 'rejected') return;
    const outcomeKey = outcome.operationId || `${outcome.reason}:${outcome.message || ''}`;
    if (outcomeHandled.current === outcomeKey) return;
    outcomeHandled.current = outcomeKey;
    notify(outcome.message || 'That change could not be saved.');
  }, [sessionState.outcome]);
  useEffect(() => {
    const outcome = sessionState.outcome;
    if (!outcome || (outcome.kind !== 'missing' && outcome.kind !== 'deleted') || terminalHandled.current) return;
    terminalHandled.current = true;
    notify(outcome.kind === 'missing' ? 'This list no longer exists.' : 'This list was deleted by its owner.');
    forgetList(true);
    navigate('/');
  }, [forgetList, navigate, sessionState.outcome]);
  useEffect(() => {
    const listName = sessionState.list?.name;
    if (!listName) return;
    replaceLists((previous) => previous.map((item) => item.id === id && item.name !== listName
      ? { ...item, name: listName } : item));
  }, [id, replaceLists, sessionState.list?.name]);

  const items = useMemo(() => sortItems(list?.items || [], preferences), [list, preferences]);
  const memberNames = useMemo(() => new Map(sessionState.members.map((member) => [member.clientId, member.name])), [sessionState.members]);
  const updatePreferences = (next: ListPreferences) => setPreferences(id, next);
  const askDelete = (item: ListItem) => openConfirm({
    title: 'Delete item?',
    body: `Delete “${item.name}”? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => { session.deleteItem(item.id); },
  });
  const addForm = useForm({
    defaultValues: { name: '', amount: '' },
    validators: { onChange: itemSchema, onSubmit: itemSchema },
    onSubmit: ({ value, formApi }) => {
      session.addItem({ name: value.name.trim(), amount: value.amount.trim() });
      formApi.reset();
      requestAnimationFrame(() => addNameRef.current?.focus());
    },
  });

  const openListMenu = () => {
    if (!list) return;
    openMenuDialog({
      title: list.name,
      actions: [
        { icon: 'share', label: 'Invite people…', onSelect: () => openShare({ list }) },
        { icon: 'sort', label: 'Sort and group items…', onSelect: () => openSort({ preferences, onApply: updatePreferences }) },
        { icon: 'edit', label: 'Rename list', onSelect: () => openPrompt({
          title: 'Rename list',
          label: 'Choose a name people will recognize.',
          value: list.name,
          maxLength: 60,
          validation: 'list-name',
          confirmLabel: 'Rename',
          onConfirm: (name) => { session.renameList(name); },
        }) },
        { icon: 'clear', label: 'Clear list…', danger: true, onSelect: () => openConfirm({
          title: 'Clear this list?',
          body: list.items.length ? `This removes all ${list.items.length} items for everyone in the list. This cannot be undone.` : 'The list is already empty.',
          confirmLabel: list.items.length ? 'Clear all items' : 'OK',
          danger: true,
          onConfirm: () => { if (list.items.length) session.clearList(); },
        }) },
        ...(entry?.ownerToken ? [{
          icon: 'trash' as const,
          label: 'Delete list…',
          danger: true,
          onSelect: () => openConfirm({
            title: 'Delete list permanently?',
            body: 'Everyone with access loses this list and all of its items. This cannot be undone.',
            confirmLabel: 'Delete list',
            danger: true,
            onConfirm: () => { session.deleteList(entry.ownerToken); },
          }),
        }] : []),
        { icon: 'leave', label: 'Leave list', danger: true, onSelect: () => openConfirm({
          title: 'Leave this list?',
          body: 'It stays available to everyone else, and you can rejoin anytime with the invite link.',
          confirmLabel: 'Leave',
          danger: true,
          onConfirm: () => { session.close(); forgetList(); navigate('/'); },
        }) },
      ],
    });
  };

  if (!list) {
    return (
      <>
        <header className="topbar">
          <Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link>
          <div className="head-title"><h1>{entry?.name || 'List'}</h1></div>
          <span className={cn('connection-status', sessionStatusClass(sessionState.status))} role="status">{sessionStatusLabel(sessionState.status)}</span>
          <span className={cn('dot', sessionDotClass(sessionState.status))} aria-hidden="true" />
        </header>
        <div className="empty">Connecting…</div>
      </>
    );
  }

  const done = list.items.filter((item) => item.collected).length;
  const statusLabel = sessionStatusLabel(sessionState.status);
  const statusMessage = `${statusLabel}${sessionState.pending ? ' · Saving changes' : ''}`;

  return (
    <>
      <header className="topbar">
        <Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link>
        <div className="head-title">
          <h1>{list.name}</h1>
          <div className="sub">
            <span>{list.items.length ? `${list.items.length} ${list.items.length === 1 ? 'item' : 'items'} · ${done} collected` : 'Empty'}</span>
            <span className="people">
              {sessionState.online.slice(0, 4).map((participant) => <span className="avatar" role="img" aria-label={participant.name} style={{ '--c': participant.color || '#888' } as CSSProperties} title={participant.name} key={participant.clientId}>{initials(participant.name)}</span>)}
              {sessionState.online.length > 4 && <span className="more">+{sessionState.online.length - 4}</span>}
            </span>
          </div>
        </div>
        <span className={cn('connection-status', sessionStatusClass(sessionState.status))} role="status">{statusMessage}</span>
        <span className={cn('dot', sessionDotClass(sessionState.status))} aria-hidden="true" />
        <Button type="button" variant="ghost" size="icon" className="icon-btn" aria-label="List options" onClick={openListMenu}><Icon name="dots" /></Button>
      </header>
      <ul className="items">{items.map((item) => <ItemRow
        key={item.id}
        item={item}
        session={session}
        askDelete={askDelete}
        editorName={item.lastEditedBy ? memberNames.get(item.lastEditedBy) : undefined}
      />)}</ul>
      {!list.items.length && <div className="empty list-empty show"><div className="big"><Icon name="cart" /></div><p>Nothing here yet.</p><p className="muted">Add your first item with the bar below.</p></div>}
      <form className="addbar" onSubmit={(event) => { event.preventDefault(); void addForm.handleSubmit(); }}>
        <FieldGroup className="contents">
        <addForm.Field name="name">
          {(field) => (
            <Field className="field-control add-field" data-invalid={field.state.meta.errors.length > 0}>
              <Input ref={addNameRef} className="add-name" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} onBlur={field.handleBlur} placeholder="Add item…" maxLength={80} autoComplete="off" aria-label="New item name" aria-invalid={field.state.meta.errors.length > 0} />
              <FieldError field={field} />
            </Field>
          )}
        </addForm.Field>
        <addForm.Field name="amount">
          {(field) => (
            <Field className="field-control add-field amount-field" data-invalid={field.state.meta.errors.length > 0}>
              <Input className="add-amount" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} onBlur={field.handleBlur} placeholder="qty" maxLength={40} autoComplete="off" aria-label="New item amount" aria-invalid={field.state.meta.errors.length > 0} />
              <FieldError field={field} />
            </Field>
          )}
        </addForm.Field>
        </FieldGroup>
        <button className="add-btn add-btn-top-aligned" type="submit" aria-label="Add item"><Icon name="plus" /></button>
      </form>
    </>
  );
}
