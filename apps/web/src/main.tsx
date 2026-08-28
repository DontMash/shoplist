import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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

type WireMessage = Record<string, any>;
type MessageHandler = (type: string, message?: any) => void;

class ListConn {
  listId: string;
  clientId: string;
  name: string;
  emit: MessageHandler;
  outbox: WireMessage[];
  attempt: number;
  closed: boolean;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  status: string;

  constructor(id: string, clientId: string, name: string, emit: MessageHandler) { this.listId = id; this.clientId = clientId; this.name = name; this.emit = emit; this.outbox = []; this.attempt = 0; this.closed = false; this.socket = null; this.timer = null; this.status = 'connecting'; this.connect(); }
  setStatus(s: string) { if (s !== this.status) { this.status = s; this.emit('status', s); } }
  connect() {
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    let socket; try { socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?list=${encodeURIComponent(this.listId)}&client=${encodeURIComponent(this.clientId)}&name=${encodeURIComponent(this.name || 'Guest')}`); } catch { this.retry(); return; }
    this.socket = socket;
    socket.onopen = () => { this.attempt = 0; this.setStatus('live'); this.outbox.splice(0).forEach(m => socket.send(JSON.stringify(m))); };
    socket.onmessage = (event) => { try { const msg = JSON.parse(event.data); if (msg?.t) this.emit(msg.t, msg); } catch {} };
    socket.onerror = () => { try { socket.close(); } catch {} };
    socket.onclose = (event) => { this.socket = null; if (this.closed) return; if (event.code === 4004) { this.setStatus('missing'); this.emit('missing'); } else this.retry(); };
  }
  retry() { const delay = Math.min(15000, 700 * 2 ** this.attempt++) + Math.random() * 500; this.setStatus('reconnecting'); clearTimeout(this.timer); this.timer = setTimeout(() => !this.closed && this.connect(), delay); }
  kick() { if (!this.socket) { clearTimeout(this.timer); this.attempt = 0; this.connect(); } }
  send(message: WireMessage) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); else if (message.t !== 'ping') { this.outbox.push(message); if (this.outbox.length > 200) this.outbox.shift(); } }
  close() { this.closed = true; clearTimeout(this.timer); try { this.socket?.close(); } catch {} this.socket = null; }
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
  const [invite, setInvite] = useState('');
  const [meta, setMeta] = useState({});
  useEffect(() => { let alive = true; lists.forEach(async entry => { try { const r = await fetch(`/api/lists/${encodeURIComponent(entry.id)}`); if (!alive) return; if (r.status === 404) setMeta(x => ({ ...x, [entry.id]: { gone: true } })); else { const data = await r.json(); const items = data.items || []; setMeta(x => ({ ...x, [entry.id]: { text: items.length ? `${items.length} ${items.length === 1 ? 'item' : 'items'} · ${items.filter(i => i.collected).length} collected` : 'Empty — add something!' } })); } } catch { if (alive) setMeta(x => ({ ...x, [entry.id]: { text: 'Offline — showing saved info' } })); } }); return () => { alive = false; }; }, [lists]);
  const create = async (name) => { try { const r = await fetch('/api/lists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); if (!r.ok) throw Error(); const data = await r.json(); const entry = { id: data.list.id, name: data.list.name, ownerToken: data.ownerToken, joinedAt: Date.now() }; setLists(x => { const next = [entry, ...x.filter(l => l.id !== entry.id)]; save('sl.lists', next); return next; }); sessionStorage.setItem('sl.share', entry.id); navigate(`/list/${entry.id}`); } catch { toast('Could not create the list — are you online?'); } };
  const remove = id => {
    setLists(x => x.filter(l => l.id !== id));
    const prefs = read('sl.listPrefs', {});
    delete prefs[id];
    save('sl.listPrefs', prefs);
  };
  return <div className="home">
    <header className="home-hero"><h1 className="logo">Shoplist</h1><p className="tagline">Shared shopping lists — realtime, invite-only, no accounts.</p><button className="who" onClick={() => openPrompt({ title: 'Your name', label: 'This is what other people in the list will see.', value: me.name, confirmLabel: 'Save', onConfirm: name => { const next = { ...me, name }; setMe(next); save('sl.name', name); } })}>You appear as <b>{me.name || 'Guest'}</b> <Icon name="edit" /></button></header>
    <h2 className="sec-title">Your lists</h2><div className="lists">{lists.length ? [...lists].sort((a,b) => (b.joinedAt||0)-(a.joinedAt||0)).map(entry => <Link className={`card ${meta[entry.id]?.gone ? 'gone' : ''}`} href={`/list/${entry.id}`} key={entry.id} onClick={meta[entry.id]?.gone ? e => { e.preventDefault(); openConfirm({ title: 'Remove from this device?', body: `The list “${entry.name}” no longer exists on the server. Remove it from your overview?`, confirmLabel: 'Remove', danger: true, onConfirm: () => remove(entry.id) }); } : undefined}><div className="card-name">{entry.name}</div><div className="card-meta">{meta[entry.id]?.gone ? 'This list was deleted or no longer exists — tap to remove it.' : (meta[entry.id]?.text || '…')}</div></Link>) : <div className="empty"><div className="big"><Icon name="cart" /></div><p>No lists yet. Create one, then share the invite link or QR code with the people you shop with.</p><Button variant="primary" onClick={() => openPrompt({ title: 'New list', label: 'What is this shopping trip for?', placeholder: 'e.g. Weekly groceries', confirmLabel: 'Create list', onConfirm: create })}>Create your first list</Button></div>}</div>
    <section className="joinbox"><h2 className="sec-title">Have an invite?</h2><form className="inline-form" onSubmit={e => { e.preventDefault(); const id = extractListId(invite); if (!id) return toast("That doesn't look like an invite link"); setInvite(''); navigate(`/join/${id}`); }}><Input value={invite} onChange={e => setInvite(e.target.value)} placeholder="Paste invite link or code" maxLength={300} autoComplete="off" aria-label="Invite link or code" /><Button type="submit" variant="primary">Join</Button></form></section>
    <button className="fab" aria-label="New list" onClick={() => openPrompt({ title: 'New list', label: 'What is this shopping trip for?', placeholder: 'e.g. Weekly groceries', confirmLabel: 'Create list', onConfirm: create })}><Icon name="plus" /><span>New list</span></button>
  </div>;
}

function Join({ id, me, setMe, setLists }) {
  const [, navigate] = useLocation();
  const [meta, setMeta] = useState(null); const [error, setError] = useState(''); const [name, setName] = useState(me.name || '');
  useEffect(() => {
    let alive = true;
    fetch(`/api/lists/${encodeURIComponent(id)}`)
      .then(async response => {
        if (response.status === 404) throw Error('missing');
        if (!response.ok) throw Error('request-failed');
        return response.json();
      })
      .then(x => alive && setMeta(x))
      .catch(error => alive && setError(error.message === 'missing'
        ? 'This invite is not valid — the list doesn\'t exist (anymore).'
        : 'You seem to be offline. Reconnect to join this list.'));
    return () => { alive = false; };
  }, [id]);
  const join = () => { if (!name.trim()) return; const nextName = name.trim(); setMe(x => ({ ...x, name: nextName })); save('sl.name', nextName); setLists(x => { const next = x.some(l => l.id === id) ? x : [{ id, name: meta.list.name, ownerToken: null, joinedAt: Date.now() }, ...x]; save('sl.lists', next); return next; }); navigate(`/list/${id}`); };
  return <div className="center-page"><div className="join-card"><div className="big"><Icon name="cart" /></div><h1>{meta ? `Join “${meta.list.name}”` : 'Join list'}</h1><p className="muted">{error || (!meta ? 'Loading…' : meta.memberCount > 0 ? `${meta.memberCount} ${meta.memberCount === 1 ? 'person has' : 'people have'} this list on their device. No account needed — pick a name and jump in.` : 'No account needed — pick a name and jump in.')}</p>{meta && <div className="stack"><Input autoFocus={!me.name} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" maxLength={40} aria-label="Your name" onKeyDown={e => e.key === 'Enter' && join()} /><Button variant="primary" onClick={join}>Join list</Button></div>}<Link className="backlink" href="/">Go to my lists</Link></div></div>;
}

function ItemRow({ item, conn, setList, askDelete }: { item: ListItem; conn: ListConn | null; setList: any; askDelete: (item: ListItem) => void }) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(item.amount || '');
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const offsetRef = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pending = useRef<{ name: string | null; amount: string | null }>({ name: null, amount: null });
  const collectRef = useRef<() => void>(() => {});
  const removeRef = useRef<() => void>(() => {});
  const swipeEnabled = useCoarsePointer();

  // Preserve a just-edited value until the server echoes it back. This keeps
  // full-state realtime updates from making a focused input jump backwards.
  useEffect(() => {
    if (pending.current.name === item.name) pending.current.name = null;
    if (pending.current.amount === (item.amount || '')) pending.current.amount = null;
    if (pending.current.name === null) setName(item.name);
    if (pending.current.amount === null) setAmount(item.amount || '');
  }, [item.name, item.amount]);
  useEffect(() => () => Object.values(timers.current).forEach(timer => clearTimeout(timer)), []);

  const commit = field => {
    const value = (field === 'name' ? name : amount).trim();
    const current = field === 'name' ? item.name : (item.amount || '');
    if (field === 'name' && !value) {
      pending.current.name = null;
      setName(item.name);
      return;
    }
    if (value !== current) {
      pending.current[field] = value;
      conn?.send({ t: 'item:update', id: item.id, patch: { [field]: value } });
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
    setList(x => ({ ...x, items: x.items.map(i => i.id === item.id ? { ...i, collected: !i.collected } : i) }));
    conn?.send({ t: 'item:update', id: item.id, patch: { collected: !item.collected } });
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

  return <li ref={rowRef} className={`item ${item.collected ? 'collected' : ''} ${swiping ? 'swiping' : ''}`} data-id={item.id}><div className="item-swipe"><button type="button" className="swipe-action swipe-collect" onClick={collect}><Icon name="check" /><span>Collect</span></button><button type="button" className="swipe-action swipe-delete" onClick={remove}><Icon name="trash" /><span>Delete</span></button><div className="item-content" style={{ transform: `translateX(${offset}px)` }}><div className="item-row1"><input className="item-name" value={name} onChange={e => { pending.current.name = e.target.value; setName(e.target.value); schedule('name'); }} onBlur={() => { clearTimeout(timers.current.nameTimer); commit('name'); }} onKeyDown={e => e.key === 'Enter' && e.preventDefault()} maxLength={80} aria-label="Item name" /><input className="item-amount" value={amount} onChange={e => { pending.current.amount = e.target.value; setAmount(e.target.value); schedule('amount'); }} onBlur={() => { clearTimeout(timers.current.amountTimer); commit('amount'); }} maxLength={40} placeholder="qty" aria-label="Amount" /></div><div className="item-row2"><button type="button" className="chip chip-collected" aria-pressed={!!item.collected} onClick={collect}><Icon name="check" /><span>Collected</span></button><span className="spacer" /><Button type="button" variant="ghost" size="icon" className="icon-btn item-del" aria-label="Delete item" onClick={remove}><Icon name="trash" /></Button></div></div></div></li>;
}

function ListPage({ id, entry, me, setLists, openDialog, openConfirm, toast }) {
  const [, navigate] = useLocation();
  const [list, setList] = useState(null); const [online, setOnline] = useState([]); const [status, setStatus] = useState('connecting'); const connRef = useRef(null); const [prefs, setPrefs] = useState(() => { const all = read('sl.listPrefs', {}); const p = all[id] || {}; return { sort: SORT_VALUES.has(p.sort) ? p.sort : 'created-asc', groupCollected: p.groupCollected !== false }; });
  const forgetList = () => {
    setLists(previous => previous.filter(item => item.id !== id));
    const all = read('sl.listPrefs', {});
    delete all[id];
    save('sl.listPrefs', all);
  };
  useEffect(() => { const connection = new ListConn(id, me.clientId, me.name, (type, msg) => { if (type === 'init' || type === 'state') { setList(msg.list); if (type === 'init') setOnline(msg.online || []); setLists(previous => { const next = previous.map(item => item.id === id && item.name !== msg.list.name ? { ...item, name: msg.list.name } : item); save('sl.lists', next); return next; }); } else if (type === 'presence') setOnline(msg.online || []); else if (type === 'status') setStatus(msg); else if (type === 'missing') { toast('This list no longer exists.'); forgetList(); navigate('/'); } else if (type === 'closed' && msg.reason === 'deleted') { toast('This list was deleted by its owner.'); forgetList(); navigate('/'); } }); connRef.current = connection; return () => connection.close(); }, [id]);
  useEffect(() => { const onlineHandler = () => connRef.current?.kick(); window.addEventListener('online', onlineHandler); return () => window.removeEventListener('online', onlineHandler); }, []);
  const conn = connRef.current; const items = useMemo(() => sortItems(list?.items || [], prefs), [list, prefs]);
  const updatePrefs = p => { const next = { ...prefs, ...p }; setPrefs(next); const all = read('sl.listPrefs', {}); save('sl.listPrefs', { ...all, [id]: next }); };
  const askDelete = item => openConfirm({ title: 'Delete item?', body: `Delete “${item.name}”? This cannot be undone.`, confirmLabel: 'Delete', danger: true, onConfirm: () => { setList(x => x && ({ ...x, items: x.items.filter(i => i.id !== item.id) })); connRef.current?.send({ t: 'item:delete', id: item.id }); } });
  const add = e => { e.preventDefault(); const form = e.currentTarget; const name = form.name.value.trim(); if (!name) return form.name.focus(); connRef.current?.send({ t: 'item:add', item: { name, amount: form.amount.value.trim() } }); form.reset(); form.name.focus(); };
  const openMenu = () => openDialog({ type: 'menu', title: list?.name, actions: [{ label: 'Done' }], content: <div className="menu-list"><MenuButton icon="share" label="Invite people…" onClick={() => openDialog({ type: 'share', list })} /><MenuButton icon="sort" label="Sort and group items…" onClick={() => openDialog({ type: 'sort', prefs, setPrefs: updatePrefs })} /><MenuButton icon="edit" label="Rename list" onClick={() => openDialog({ type: 'rename', value: list?.name, onConfirm: value => connRef.current?.send({ t: 'list:rename', name: value }) })} /><MenuButton icon="clear" label="Clear list…" danger onClick={() => openConfirm({ title: 'Clear this list?', body: list?.items.length ? `This removes all ${list.items.length} items for everyone in the list. This cannot be undone.` : 'The list is already empty.', confirmLabel: list?.items.length ? 'Clear all items' : 'OK', danger: true, onConfirm: () => list?.items.length && connRef.current?.send({ t: 'list:clear' }) })} />{entry?.ownerToken && <MenuButton icon="trash" label="Delete list…" danger onClick={() => openConfirm({ title: 'Delete list permanently?', body: 'Everyone with access loses this list and all of its items. This cannot be undone.', confirmLabel: 'Delete list', danger: true, onConfirm: () => connRef.current?.send({ t: 'list:delete', ownerToken: entry.ownerToken }) })} />}<MenuButton icon="leave" label="Leave list" danger onClick={() => openConfirm({ title: 'Leave this list?', body: 'It stays available to everyone else, and you can rejoin anytime with the invite link.', confirmLabel: 'Leave', danger: true, onConfirm: () => { forgetList(); navigate('/'); } })} /></div> });
  if (!list) return <><header className="topbar"><Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link><div className="head-title"><h1>{entry.name}</h1></div><span className={`dot ${status === 'live' ? 'live' : status === 'missing' ? 'missing' : 'connecting'}`} /></header><div className="empty">Connecting…</div></>;
  const done = list.items.filter(i => i.collected).length;
  return <><header className="topbar"><Link href="/" className="icon-btn" aria-label="All lists"><Icon name="back" /></Link><div className="head-title"><h1>{list.name}</h1><div className="sub"><span>{list.items.length ? `${list.items.length} ${list.items.length === 1 ? 'item' : 'items'} · ${done} collected` : 'Empty'}</span><span className="people">{online.slice(0,4).map(p => <span className="avatar" style={{ '--c': p.color || '#888' } as React.CSSProperties} title={p.name} key={p.clientId}>{initials(p.name)}</span>)}{online.length > 4 && <span className="more">+{online.length-4}</span>}</span></div></div><span className={`dot ${status === 'live' ? 'live' : status === 'missing' ? 'missing' : 'connecting'}`} title={status} /><Button type="button" variant="ghost" size="icon" className="icon-btn" aria-label="List options" onClick={openMenu}><Icon name="dots" /></Button></header><ul className="items">{items.map(item => <ItemRow key={item.id} item={item} conn={connRef.current} setList={setList} askDelete={askDelete} />)}</ul>{!list.items.length && <div className="empty list-empty show"><div className="big"><Icon name="basket" /></div><p>Nothing here yet.</p><p className="muted">Add your first item with the bar below.</p></div>}<form className="addbar" onSubmit={add}><input className="add-name" name="name" placeholder="Add item…" maxLength={80} autoComplete="off" aria-label="New item name" /><input className="add-amount" name="amount" placeholder="qty" maxLength={40} autoComplete="off" aria-label="New item amount" /><button className="add-btn" aria-label="Add item"><Icon name="plus" /></button></form></>;
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
  const [value, setValue] = useState(dialog.value || '');
  const submit = () => { const v = value.trim(); if (!v) return; dialog.onConfirm(v); close(); };
  return <Modal open onOpenChange={open => !open && close()} title={dialog.title} actions={[{ label: 'Cancel', onClick: close }, { label: dialog.confirmLabel || 'Save', kind: 'primary', onClick: submit }]}><p>{dialog.label}</p><Input className="mt-2.5" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder={dialog.placeholder} maxLength={dialog.maxlength || 60} onKeyDown={e => e.key === 'Enter' && submit()} /></Modal>;
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
  const [sort, setSort] = useState(prefs.sort); const [group, setGroup] = useState(prefs.groupCollected);
  return <Modal open onOpenChange={open => !open && close()} title="Sort items" actions={[{ label: 'Cancel', onClick: close }, { label: 'Apply', kind: 'primary', onClick: () => { setPrefs({ sort, groupCollected: group }); close(); } }]}><div className="sort-settings"><label className="setting"><span>Sort items by</span><select className="w-full rounded-xl border border-input bg-card px-3 py-2.5 text-base" value={sort} onChange={e => setSort(e.target.value)}>{SORT_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="setting-check"><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} /><span>Group collected items at the bottom</span></label><p className="hint muted">These display settings are saved on this device only.</p></div></Modal>;
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

createRoot(document.getElementById('root')!).render(
  <Router hook={useHashLocation}>
    <App />
  </Router>,
);
