import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { useLiveQuery } from '@tanstack/react-db';
import { registerSW } from 'virtual:pwa-register';
import interact from 'interactjs';
import { Link, Route, Router, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import './app.css';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { extractListId, initials, SORT_OPTIONS, SORT_VALUES, sortItems, uid, type ListItem } from './lib/list';
import { ApiError, createList as createListRequest, fetchList, listQueryKey, type ListResponse } from './lib/api';
import { createListSession, getListSessionCollection, type ListSession } from './lib/list-session';
import { displayNameSchema, inviteSchema, itemEditSchema, itemSchema, listNameSchema, preferencesSchema, promptSchema } from './lib/schemas';
import {
  IconArrowsSort,
  IconBasket,
  IconCheck,
  IconChevronLeft,
  IconCircleX,
  IconCopy,
  IconDots,
  IconLogout,
  IconPencil,
  IconPlus,
  IconShare,
  IconShoppingCart,
  IconTrash,
} from '@tabler/icons-react';

const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const ICONS = {
  plus: IconPlus,
  back: IconChevronLeft,
  dots: IconDots,
  trash: IconTrash,
  check: IconCheck,
  share: IconShare,
  copy: IconCopy,
  edit: IconPencil,
  clear: IconCircleX,
  leave: IconLogout,
  sort: IconArrowsSort,
  cart: IconShoppingCart,
  basket: IconBasket,
};

function Icon({ name, ...props }) {
  const IconComponent = ICONS[name];
  return IconComponent ? <IconComponent size={24} stroke={2} aria-hidden="true" {...props} /> : null;
}

function FieldError({ field }) {
  const errors = field.state.meta.errors || [];
  if (!errors.length) return null;
  return <span className="form-error" role="alert">{errors.map(error => typeof error === 'string' ? error : error?.message || String(error)).join(', ')}</span>;
}

type Toast = { id: string; message: string };

function useToasts(): [Toast[], (message: string) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((message) => { const id = uid(); setToasts(x => [...x, { id, message }]); setTimeout(() => setToasts(x => x.filter(t => t.id !== id)), 3000); }, []);
  return [toasts, toast];
}

const COARSE_POINTER_QUERY = '(pointer: coarse)';

function useCoarsePointer() {
  const [enabled, setEnabled] = useState(() => (
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(COARSE_POINTER_QUERY).matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(COARSE_POINTER_QUERY);
    const update = () => setEnabled(media.matches);
    update();
    media.addEventListener?.('change', update);
    // Safari versions that predate MediaQueryList.addEventListener.
    media.addListener?.(update);
    return () => {
      media.removeEventListener?.('change', update);
      media.removeListener?.(update);
    };
  }, []);

  return enabled;
}

function Shell({ children, toasts }) { return <><main id="app">{children}</main><div id="toasts" aria-live="polite">{toasts.map(t => <div className="toast" key={t.id}>{t.message}</div>)}</div></>; }

function Home({ me, setMe, lists, setLists, openPrompt, openConfirm, toast }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const listQueries = useQueries({
    queries: lists.map(entry => ({
      queryKey: listQueryKey(entry.id),
      queryFn: ({ signal }) => fetchList(entry.id, signal),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const meta = useMemo(() => Object.fromEntries(lists.map((entry, index) => {
    const query = listQueries[index];
    const data = query?.data as ListResponse | undefined;
    if (query?.error instanceof ApiError && query.error.status === 404) return [entry.id, { gone: true }];
    if (query?.isError) return [entry.id, { text: 'Offline — showing saved info' }];
    const items = data?.items || [];
    return [entry.id, { text: query?.isPending ? '…' : items.length ? `${items.length} ${items.length === 1 ? 'item' : 'items'} · ${items.filter(i => i.collected).length} collected` : 'Empty — add something!' }];
  })), [lists, listQueries]);
  const createMutation = useMutation({ mutationFn: createListRequest });
  const inviteForm = useForm({
    defaultValues: { invite: '' },
    validators: {
      onChange: inviteSchema,
      onSubmit: inviteSchema,
    },
    onSubmit: ({ value }) => {
      const id = extractListId(value.invite);
      if (!id) return;
      inviteForm.reset();
      navigate(`/join/${id}`);
    },
  });
  const create = async (name) => {
    try {
      const data = await createMutation.mutateAsync(name);
      const entry = { id: data.list.id, name: data.list.name, ownerToken: data.ownerToken, joinedAt: Date.now() };
      queryClient.setQueryData(listQueryKey(entry.id), { list: data.list, items: [], memberCount: 0 });
      setLists(x => [entry, ...x.filter(l => l.id !== entry.id)]);
      sessionStorage.setItem('sl.share', entry.id);
      navigate(`/list/${entry.id}`);
    } catch {
      toast('Could not create the list — are you online?');
    }
  };
  const remove = id => {
    queryClient.removeQueries({ queryKey: listQueryKey(id) });
    setLists(x => x.filter(l => l.id !== id));
    const prefs = read('sl.listPrefs', {});
    delete prefs[id];
    save('sl.listPrefs', prefs);
  };
  return <div className="home">
    <header className="home-hero"><h1 className="logo">Shoplist</h1><p className="tagline">Shared shopping lists — realtime, invite-only, no accounts.</p><button className="who" onClick={() => openPrompt({ title: 'Your name', label: 'This is what other people in the list will see.', value: me.name, maxlength: 40, confirmLabel: 'Save', onConfirm: name => { const next = { ...me, name }; setMe(next); save('sl.name', name); } })}>You appear as <b>{me.name || 'Guest'}</b> <Icon name="edit" /></button></header>
    <h2 className="sec-title">Your lists</h2><div className="lists">{lists.length ? [...lists].sort((a,b) => (b.joinedAt||0)-(a.joinedAt||0)).map(entry => <Link className={`card ${meta[entry.id]?.gone ? 'gone' : ''}`} href={`/list/${entry.id}`} key={entry.id} onClick={meta[entry.id]?.gone ? e => { e.preventDefault(); openConfirm({ title: 'Remove from this device?', body: `The list “${entry.name}” no longer exists on the server. Remove it from your overview?`, confirmLabel: 'Remove', danger: true, onConfirm: () => remove(entry.id) }); } : undefined}><div className="card-name">{entry.name}</div><div className="card-meta">{meta[entry.id]?.gone ? 'This list was deleted or no longer exists — tap to remove it.' : (meta[entry.id]?.text || '…')}</div></Link>) : <div className="empty"><div className="big"><Icon name="cart" /></div><p>No lists yet. Create one, then share the invite link or QR code with the people you shop with.</p><Button variant="primary" onClick={() => openPrompt({ title: 'New list', label: 'What is this shopping trip for?', placeholder: 'e.g. Weekly groceries', confirmLabel: 'Create list', onConfirm: create })}>Create your first list</Button></div>}</div>
    <section className="joinbox"><h2 className="sec-title">Have an invite?</h2><form className="inline-form" onSubmit={e => { e.preventDefault(); void inviteForm.handleSubmit(); }}><inviteForm.Field name="invite">{field => <div className="field-control"><Input value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur} placeholder="Paste invite link or code" maxLength={300} autoComplete="off" aria-label="Invite link or code" aria-invalid={field.state.meta.errors.length > 0} /><FieldError field={field} /></div>}</inviteForm.Field><Button type="submit" variant="primary">Join</Button></form></section>
    <button className="fab" aria-label="New list" onClick={() => openPrompt({ title: 'New list', label: 'What is this shopping trip for?', placeholder: 'e.g. Weekly groceries', confirmLabel: 'Create list', onConfirm: create })}><Icon name="plus" /><span>New list</span></button>
  </div>;
}

function Join({ id, me, setMe, setLists }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: listQueryKey(id),
    queryFn: ({ signal }) => fetchList(id, signal),
    staleTime: 30_000,
    retry: false,
  });
  const meta = query.data;
  const joinForm = useForm({
    defaultValues: { name: me.name || '' },
    validators: {
      onChange: displayNameSchema,
      onSubmit: displayNameSchema,
    },
    onSubmit: ({ value }) => {
      if (!meta) return;
      const nextName = value.name.trim();
      setMe(x => ({ ...x, name: nextName }));
      save('sl.name', nextName);
      setLists(x => x.some(l => l.id === id) ? x : [{ id, name: meta.list.name, ownerToken: null, joinedAt: Date.now() }, ...x]);
      queryClient.setQueryData(listQueryKey(id), meta);
      navigate(`/list/${id}`);
    },
  });
  const error = query.error instanceof ApiError && query.error.status === 404
    ? 'This invite is not valid — the list doesn\'t exist (anymore).'
    : query.isError ? 'You seem to be offline. Reconnect to join this list.' : '';
  return <div className="center-page"><div className="join-card"><div className="big"><Icon name="cart" /></div><h1>{meta ? `Join “${meta.list.name}”` : 'Join list'}</h1><p className="muted">{error || (query.isPending ? 'Loading…' : meta?.memberCount && meta.memberCount > 0 ? `${meta.memberCount} ${meta.memberCount === 1 ? 'person has' : 'people have'} this list on their device. No account needed — pick a name and jump in.` : 'No account needed — pick a name and jump in.')}</p>{meta && <form className="stack" onSubmit={e => { e.preventDefault(); void joinForm.handleSubmit(); }}><joinForm.Field name="name">{field => <><Input autoFocus={!me.name} value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur} placeholder="Your name" maxLength={40} aria-label="Your name" aria-invalid={field.state.meta.errors.length > 0} /><FieldError field={field} /></>}</joinForm.Field><Button type="submit" variant="primary">Join list</Button></form>}<Link className="backlink" href="/">Go to my lists</Link></div></div>;
}

function ItemRow({ item, session, askDelete }: { item: ListItem; session: ListSession; askDelete: (item: ListItem) => void }) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const offsetRef = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pending = useRef<{ name: string | null; amount: string | null }>({ name: null, amount: null });
  const collectRef = useRef<() => void>(() => {});
  const removeRef = useRef<() => void>(() => {});
  const swipeEnabled = useCoarsePointer();
  const itemForm = useForm({
    defaultValues: { name: item.name, amount: item.amount || '' },
    validators: { onChange: itemEditSchema },
  });

  // Preserve a just-edited value until the server echoes it back. This keeps
  // full-state realtime updates from making a focused input jump backwards.
  useEffect(() => {
    if (pending.current.name === item.name) pending.current.name = null;
    if (pending.current.amount === (item.amount || '')) pending.current.amount = null;
    if (pending.current.name === null && itemForm.getFieldValue('name') !== item.name) itemForm.setFieldValue('name', item.name);
    if (pending.current.amount === null && itemForm.getFieldValue('amount') !== (item.amount || '')) itemForm.setFieldValue('amount', item.amount || '');
  }, [item.name, item.amount]);
  useEffect(() => () => Object.values(timers.current).forEach(timer => clearTimeout(timer)), []);

  const commit = field => {
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
    } else pending.current[field] = null;
  };
  const schedule = field => {
    clearTimeout(timers.current[field + 'Timer']);
    timers.current[field + 'Timer'] = setTimeout(() => commit(field), 350);
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

  // interact.js is enabled only for a coarse primary pointer. This is an
  // input-capability check rather than a viewport-width breakpoint, so mouse
  // users on desktop never get a horizontal drag interaction. startAxis keeps
  // vertical gestures available to the browser for normal page scrolling.
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
      onmove: event => {
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

  return <li ref={rowRef} className={`item ${item.collected ? 'collected' : ''} ${swiping ? 'swiping' : ''}`} data-id={item.id}><div className="item-swipe"><button type="button" className="swipe-action swipe-collect" onClick={collect}><Icon name="check" /><span>Collect</span></button><button type="button" className="swipe-action swipe-delete" onClick={remove}><Icon name="trash" /><span>Delete</span></button><div className="item-content" style={{ transform: `translateX(${offset}px)` }}><div className="item-row1"><itemForm.Field name="name">{field => <input className="item-name" value={field.state.value} onChange={e => { pending.current.name = e.target.value; field.handleChange(e.target.value); schedule('name'); }} onBlur={() => { field.handleBlur(); clearTimeout(timers.current.nameTimer); commit('name'); }} onKeyDown={e => e.key === 'Enter' && e.preventDefault()} maxLength={80} aria-label="Item name" aria-invalid={field.state.meta.errors.length > 0} />}</itemForm.Field><itemForm.Field name="amount">{field => <input className="item-amount" value={field.state.value} onChange={e => { pending.current.amount = e.target.value; field.handleChange(e.target.value); schedule('amount'); }} onBlur={() => { field.handleBlur(); clearTimeout(timers.current.amountTimer); commit('amount'); }} maxLength={40} placeholder="qty" aria-label="Amount" aria-invalid={field.state.meta.errors.length > 0} />}</itemForm.Field></div><div className="item-row2"><button type="button" className="chip chip-collected" aria-pressed={!!item.collected} onClick={collect}><Icon name="check" /><span>Collected</span></button><span className="spacer" /><Button type="button" variant="ghost" size="icon" className="icon-btn item-del" aria-label="Delete item" onClick={remove}><Icon name="trash" /></Button></div></div></div></li>;
}

function ListPage({ id, entry, me, setLists, openDialog, openConfirm, toast }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const addNameRef = useRef<HTMLInputElement>(null);
  const terminalHandled = useRef(false);
  const outcomeHandled = useRef<string | null>(null);
  const session = useMemo(() => createListSession({
    listId: id,
    clientId: me.clientId,
    name: me.name,
    ownerToken: entry?.ownerToken,
    queryClient,
  }), [id, me.clientId, me.name, entry?.ownerToken, queryClient]);
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  // The collection is the reactive item source. Session metadata deliberately
  // remains outside the collection so revision/status/outcomes stay scalar.
  const liveItems = useLiveQuery(getListSessionCollection(session) as any);
  const [prefs, setPrefs] = useState(() => { const all = read('sl.listPrefs', {}); const p = all[id] || {}; return { sort: SORT_VALUES.has(p.sort) ? p.sort : 'created-asc', groupCollected: p.groupCollected !== false }; });
  const collectionItems = (liveItems.data || []) as ListItem[];
  const list = sessionState.list
    ? {
        ...sessionState.list,
        items: sessionState.items.map((item) => collectionItems.find((candidate) => candidate.id === item.id) || item),
      }
    : null;
  const forgetList = useCallback(() => {
    queryClient.removeQueries({ queryKey: listQueryKey(id) });
    setLists(previous => previous.filter(item => item.id !== id));
    const all = read('sl.listPrefs', {});
    delete all[id];
    save('sl.listPrefs', all);
  }, [id, queryClient, setLists]);
  useEffect(() => () => session.close(), [session]);
  useEffect(() => {
    const onlineHandler = () => session.kick();
    window.addEventListener('online', onlineHandler);
    return () => window.removeEventListener('online', onlineHandler);
  }, [session]);
  useEffect(() => {
    const outcome = sessionState.outcome;
    if (!outcome || outcome.kind !== 'rejected' || !outcome.operationId || outcomeHandled.current === outcome.operationId) return;
    outcomeHandled.current = outcome.operationId;
    toast(outcome.message || 'That change could not be saved.');
  }, [sessionState.outcome, toast]);
  useEffect(() => {
    const outcome = sessionState.outcome;
    if (!outcome || (outcome.kind !== 'missing' && outcome.kind !== 'deleted') || terminalHandled.current) return;
    terminalHandled.current = true;
    toast(outcome.kind === 'missing' ? 'This list no longer exists.' : 'This list was deleted by its owner.');
    forgetList();
    navigate('/');
  }, [sessionState.outcome, forgetList, navigate, toast]);
  useEffect(() => {
    if (!sessionState.list) return;
    setLists(previous => previous.map(item => item.id === id && item.name !== sessionState.list!.name
      ? { ...item, name: sessionState.list!.name } : item));
  }, [id, sessionState.list?.name, setLists]);
  const items = useMemo(() => sortItems(list?.items || [], prefs), [list, prefs]);
  const updatePrefs = p => { const next = { ...prefs, ...p }; setPrefs(next); const all = read('sl.listPrefs', {}); save('sl.listPrefs', { ...all, [id]: next }); };
  const askDelete = item => openConfirm({ title: 'Delete item?', body: `Delete “${item.name}”? This cannot be undone.`, confirmLabel: 'Delete', danger: true, onConfirm: () => { session.deleteItem(item.id); } });
  const addForm = useForm({
    defaultValues: { name: '', amount: '' },
    validators: { onChange: itemSchema, onSubmit: itemSchema },
    onSubmit: ({ value, formApi }) => {
      session.addItem({ name: value.name.trim(), amount: value.amount.trim() });
      formApi.reset();
      requestAnimationFrame(() => addNameRef.current?.focus());
    },
  });
  const openMenu = () => openDialog({ type: 'menu', title: list?.name, actions: [{ label: 'Done' }], content: <div className="menu-list"><MenuButton icon="share" label="Invite people…" onClick={() => openDialog({ type: 'share', list })} /><MenuButton icon="sort" label="Sort and group items…" onClick={() => openDialog({ type: 'sort', prefs, setPrefs: updatePrefs })} /><MenuButton icon="edit" label="Rename list" onClick={() => openDialog({ type: 'rename', value: list?.name, onConfirm: value => session.renameList(value) })} /><MenuButton icon="clear" label="Clear list…" danger onClick={() => openConfirm({ title: 'Clear this list?', body: list?.items.length ? `This removes all ${list.items.length} items for everyone in the list. This cannot be undone.` : 'The list is already empty.', confirmLabel: list?.items.length ? 'Clear all items' : 'OK', danger: true, onConfirm: () => list?.items.length && session.clearList() })} />{entry?.ownerToken && <MenuButton icon="trash" label="Delete list…" danger onClick={() => openConfirm({ title: 'Delete list permanently?', body: 'Everyone with access loses this list and all of its items. This cannot be undone.', confirmLabel: 'Delete list', danger: true, onConfirm: () => session.deleteList(entry.ownerToken) })} />}<MenuButton icon="leave" label="Leave list" danger onClick={() => openConfirm({ title: 'Leave this list?', body: 'It stays available to everyone else, and you can rejoin anytime with the invite link.', confirmLabel: 'Leave', danger: true, onConfirm: () => { session.close(); forgetList(); navigate('/'); } })} /></div> });
  if (!list) return <><header className="topbar"><Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link><div className="head-title"><h1>{entry.name}</h1></div><span className={`dot ${sessionState.status === 'live' ? 'live' : sessionState.status === 'missing' ? 'missing' : 'connecting'}`} /></header><div className="empty">Connecting…</div></>;
  const done = list.items.filter(i => i.collected).length;
  return <><header className="topbar"><Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link><div className="head-title"><h1>{list.name}</h1><div className="sub"><span>{list.items.length ? `${list.items.length} ${list.items.length === 1 ? 'item' : 'items'} · ${done} collected` : 'Empty'}</span><span className="people">{sessionState.online.slice(0,4).map(p => <span className="avatar" style={{ '--c': p.color || '#888' } as React.CSSProperties} title={p.name} key={p.clientId}>{initials(p.name)}</span>)}{sessionState.online.length > 4 && <span className="more">+{sessionState.online.length-4}</span>}</span></div></div><span className={`dot ${sessionState.status === 'live' ? 'live' : sessionState.status === 'missing' ? 'missing' : 'connecting'}`} title={`${sessionState.status}${sessionState.pending ? ' · pending changes' : ''}`} /><Button type="button" variant="ghost" size="icon" className="icon-btn" aria-label="List options" onClick={openMenu}><Icon name="dots" /></Button></header><ul className="items">{items.map(item => <ItemRow key={item.id} item={item} session={session} askDelete={askDelete} />)}</ul>{!list.items.length && <div className="empty list-empty show"><div className="big"><Icon name="basket" /></div><p>Nothing here yet.</p><p className="muted">Add your first item with the bar below.</p></div>}<form className="addbar" onSubmit={e => { e.preventDefault(); void addForm.handleSubmit(); }}><addForm.Field name="name">{field => <input ref={addNameRef} className="add-name" value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur} placeholder="Add item…" maxLength={80} autoComplete="off" aria-label="New item name" aria-invalid={field.state.meta.errors.length > 0} />}</addForm.Field><addForm.Field name="amount">{field => <input className="add-amount" value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur} placeholder="qty" maxLength={40} autoComplete="off" aria-label="New item amount" aria-invalid={field.state.meta.errors.length > 0} />}</addForm.Field><button className="add-btn" type="submit" aria-label="Add item"><Icon name="plus" /></button></form></>;
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: string; label: string; onClick: () => void; danger?: boolean }) { return <button type="button" className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>; }

type ModalAction = { label: string; kind?: 'ghost' | 'primary' | 'danger'; onClick?: () => void };

type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children?: React.ReactNode;
  actions?: ModalAction[];
};

// App-level dialog composition built from the shadcn Dialog primitives.
// The primitives themselves live in src/components/ui/dialog.tsx.
function Modal({ open, onOpenChange, title, children, actions = [{ label: 'OK' }] }: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,400px)] max-h-[min(90dvh,700px)] overflow-auto rounded-[18px] bg-card p-0 text-card-foreground shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
      >
        <div className="p-5">
          {title && <DialogTitle className="mb-2 text-[1.1rem] leading-tight font-semibold">{title}</DialogTitle>}
          <div className="[&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted-foreground">
            {children}
          </div>
          <DialogFooter className="mt-[18px] flex-row flex-wrap justify-end gap-2">
            {actions.map((action, index) => (
              <Button
                key={index}
                type="button"
                variant={action.kind || 'ghost'}
                className="min-h-11 rounded-xl px-4 font-bold"
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

function PromptDialog({ dialog, close }) {
  const validationSchema = dialog.maxlength ? promptSchema(dialog.maxlength) : listNameSchema;
  const form = useForm({
    defaultValues: { value: dialog.value || '' },
    validators: { onChange: validationSchema, onSubmit: validationSchema },
    onSubmit: ({ value }) => { dialog.onConfirm(value.value.trim()); close(); },
  });
  return <Modal open onOpenChange={open => !open && close()} title={dialog.title} actions={[{ label: 'Cancel', onClick: close }, { label: dialog.confirmLabel || 'Save', kind: 'primary', onClick: () => void form.handleSubmit() }]}><p>{dialog.label}</p><form onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}><form.Field name="value">{field => <><Input className="mt-2.5" autoFocus value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur} placeholder={dialog.placeholder} maxLength={dialog.maxlength || 60} aria-invalid={field.state.meta.errors.length > 0} /><FieldError field={field} /></>}</form.Field></form></Modal>;
}

function ConfirmDialog({ dialog, close }) {
  const confirm = () => { dialog.onConfirm?.(); close(); };
  return <Modal open onOpenChange={open => !open && close()} title={dialog.title} actions={[{ label: 'Cancel', onClick: close }, { label: dialog.confirmLabel || 'Confirm', kind: dialog.danger ? 'danger' : 'primary', onClick: confirm }]}><p>{dialog.body}</p></Modal>;
}

function ShareDialog({ list, close, toast }) {
  if (!list) return null;
  const url = `${location.origin}/#/join/${list.id}`;
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Copy failed — select the link manually'); } };
  return <Modal open onOpenChange={open => !open && close()} title="Invite people" actions={[{ label: 'Done', onClick: close }]}><div className="qr"><img src={`/api/qr?data=${encodeURIComponent(url)}`} alt="QR code with the invite link" /></div><div className="share-link"><Input readOnly value={url} aria-label="Invite link" /><Button type="button" variant="ghost" size="icon" className="icon-btn" aria-label="Copy invite link" onClick={copy}><Icon name="copy" /></Button></div>{navigator.share && <Button variant="primary" className="wide mt-2.5 w-full" onClick={() => navigator.share({ title: list.name, text: `Join my shopping list “${list.name}”`, url }).catch(() => {})}>Share link…</Button>}<p className="hint muted">Anyone with this link or QR code can open this list and shop along — no account needed. Keep it private like a key.</p></Modal>;
}

function SortDialog({ prefs, setPrefs, close }) {
  const form = useForm({
    defaultValues: { sort: prefs.sort, groupCollected: prefs.groupCollected },
    validators: { onSubmit: preferencesSchema },
    onSubmit: ({ value }) => { setPrefs(value); close(); },
  });
  return <Modal open onOpenChange={open => !open && close()} title="Sort items" actions={[{ label: 'Cancel', onClick: close }, { label: 'Apply', kind: 'primary', onClick: () => void form.handleSubmit() }]}><form onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}><div className="sort-settings"><form.Field name="sort">{field => <label className="setting"><span>Sort items by</span><select className="w-full rounded-xl border border-input bg-card px-3 py-2.5 text-base" value={field.state.value} onChange={e => field.handleChange(e.target.value)} onBlur={field.handleBlur}>{SORT_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}</form.Field><form.Field name="groupCollected">{field => <label className="setting-check"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} onBlur={field.handleBlur} /><span>Group collected items at the bottom</span></label>}</form.Field><p className="hint muted">These display settings are saved on this device only.</p></div></form></Modal>;
}

function App() {
  const [route] = useLocation();
  const [me, setMe] = useState(() => ({ clientId: read('sl.client', null) || uid(), name: read('sl.name', '') || '' }));
  const [lists, setListsState] = useState(() => read('sl.lists', []) || []);
  const [dialog, setDialog] = useState<any>(null); const [toasts, toast] = useToasts();
  // Keep localStorage in sync for every route, including deletes/leaves that
  // happen from the list screen. The old DOM client did this in several
  // separate code paths; centralizing it prevents a stale list returning on
  // the next reload.
  const setLists = useCallback((update) => {
    setListsState(previous => {
      const next = typeof update === 'function' ? update(previous) : update;
      save('sl.lists', next);
      return next;
    });
  }, []);
  useEffect(() => { save('sl.client', me.clientId); }, [me.clientId]);
  useEffect(() => { setDialog(null); }, [route]);
  useEffect(() => { const online = () => toast('Back online'); const offline = () => toast('You are offline'); window.addEventListener('online', online); window.addEventListener('offline', offline); return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); }; }, [toast]);
  // Auto-updating service worker generated by vite-plugin-pwa at build time.
  // In dev (devOptions.enabled: false) this resolves to a no-op.
  useEffect(() => { registerSW({ immediate: true }); }, []);
  const close = () => setDialog(null);
  const openPrompt = data => setDialog({ type: 'prompt', ...data });
  const openConfirm = data => setDialog({ type: 'confirm', ...data });

  const page = <Switch>
    <Route path="/list/:id">
      {({ id }: { id: string }) => {
        const entry = lists.find(x => x.id === id);
        return entry
          ? <ListPage id={id} entry={entry} me={{ ...me, clientId: me.clientId }} setLists={setLists} openDialog={setDialog} openConfirm={openConfirm} toast={toast} />
          : <Join id={id} me={me} setMe={setMe} setLists={setLists} />;
      }}
    </Route>
    <Route path="/join/:id">
      {({ id }: { id: string }) => <Join id={id} me={me} setMe={setMe} setLists={setLists} />}
    </Route>
    <Route>
      <Home me={me} setMe={setMe} lists={lists} setLists={setLists} openPrompt={openPrompt} openConfirm={openConfirm} toast={toast} />
    </Route>
  </Switch>;

  let overlay = null;
  if (dialog?.type === 'prompt' || dialog?.type === 'rename') overlay = <PromptDialog dialog={dialog} close={close} />;
  else if (dialog?.type === 'confirm') overlay = <ConfirmDialog dialog={dialog} close={close} />;
  else if (dialog?.type === 'menu') overlay = <Modal open onOpenChange={open => !open && close()} title={dialog.title} actions={[{ label: 'Done', onClick: close }]}>{dialog.content}</Modal>;
  else if (dialog?.type === 'share') overlay = <ShareDialog list={dialog.list} close={close} toast={toast} />;
  else if (dialog?.type === 'sort') overlay = <SortDialog prefs={dialog.prefs || { sort: 'created-asc', groupCollected: true }} setPrefs={dialog.setPrefs || (() => {})} close={close} />;
  return <Shell toasts={toasts}>{page}{overlay}</Shell>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Router hook={useHashLocation}>
      <App />
    </Router>
  </QueryClientProvider>,
);
