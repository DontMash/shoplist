import { useMemo } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Link, useLocation } from 'wouter';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Field, FieldGroup } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { FieldError } from '../components/shared/field-error';
import { Icon } from '../components/shared/icon';
import { notify } from '../components/notification-toaster';
import { extractListId } from '../lib/list';
import { ApiError, createList as createListRequest, fetchList, listQueryKey, type ListResponse } from '../lib/api';
import { inviteSchema } from '../lib/schemas';
import { useDialogStore } from '../stores/dialog-store';
import { useParticipantStore } from '../stores/participant-store';
import { usePreferencesStore } from '../stores/preferences-store';
import { useSavedListsStore, type SavedListEntry } from '../stores/saved-lists-store';

interface ListMeta {
  gone?: boolean;
  text?: string;
}

export function HomePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const identity = useParticipantStore((state) => state.identity);
  const setName = useParticipantStore((state) => state.setName);
  const lists = useSavedListsStore((state) => state.lists);
  const setLists = useSavedListsStore((state) => state.replaceLists);
  const removeList = useSavedListsStore((state) => state.removeList);
  const removePreferences = usePreferencesStore((state) => state.removePreferences);
  const openPrompt = useDialogStore((state) => state.openPrompt);
  const openConfirm = useDialogStore((state) => state.openConfirm);

  const listQueries = useQueries({
    queries: lists.map((entry) => ({
      queryKey: listQueryKey(entry.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchList(entry.id, signal),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const meta = useMemo<Record<string, ListMeta>>(() => Object.fromEntries(lists.map((entry, index) => {
    const query = listQueries[index];
    const data = query?.data as ListResponse | undefined;
    if (query?.error instanceof ApiError && query.error.status === 404) return [entry.id, { gone: true }];
    if (query?.isError) return [entry.id, { text: 'Offline — showing saved info' }];
    const items = data?.items || [];
    const summary = items.length
      ? `${items.length} ${items.length === 1 ? 'item' : 'items'} · ${items.filter((item) => item.collected).length} collected`
      : 'Empty — add something!';
    return [entry.id, { text: query?.isPending ? '…' : summary }];
  })), [listQueries, lists]);

  const createMutation = useMutation({ mutationFn: createListRequest });
  const inviteForm = useForm({
    defaultValues: { invite: '' },
    validators: { onChange: inviteSchema, onSubmit: inviteSchema },
    onSubmit: ({ value }) => {
      const id = extractListId(value.invite);
      if (!id) return;
      inviteForm.reset();
      navigate(`/join/${id}`);
    },
  });

  const create = async (name: string) => {
    try {
      const data = await createMutation.mutateAsync(name);
      const entry: SavedListEntry = { id: data.list.id, name: data.list.name, ownerToken: data.ownerToken, joinedAt: Date.now() };
      queryClient.setQueryData(listQueryKey(entry.id), { list: data.list, items: [], memberCount: 0 });
      setLists((current) => [entry, ...current.filter((list) => list.id !== entry.id)]);
      sessionStorage.setItem('sl.share', entry.id);
      navigate(`/list/${entry.id}`);
    } catch {
      notify('Could not create the list — are you online?');
    }
  };

  const remove = (id: string) => {
    queryClient.removeQueries({ queryKey: listQueryKey(id) });
    removeList(id);
    removePreferences(id);
  };

  const openNewList = () => openPrompt({
    title: 'New list',
    label: 'What is this shopping trip for?',
    placeholder: 'e.g. Weekly groceries',
    validation: 'list-name',
    confirmLabel: 'Create list',
    onConfirm: create,
  });

  return (
    <div className="home">
      <header className="home-hero">
        <h1 className="logo">Shoplist</h1>
        <p className="tagline">Shared shopping lists — realtime, invite-only, no accounts.</p>
        <button className="who" onClick={() => openPrompt({
          title: 'Your name',
          label: 'This is what other people in the list will see.',
          value: identity.name,
          maxLength: 40,
          confirmLabel: 'Save',
          onConfirm: (name) => setName(name),
        })}>
          You appear as <b>{identity.name || 'Guest'}</b> <Icon name="edit" />
        </button>
      </header>
      <h2 className="sec-title">Your lists</h2>
      <div className="lists">
        {lists.length ? [...lists].sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)).map((entry) => (
          <Link
            className={cn('card', meta[entry.id]?.gone && 'gone')}
            href={`/list/${entry.id}`}
            key={entry.id}
            onClick={meta[entry.id]?.gone ? (event) => {
              event.preventDefault();
              openConfirm({
                title: 'Remove from this device?',
                body: `The list “${entry.name}” no longer exists on the server. Remove it from your overview?`,
                confirmLabel: 'Remove',
                danger: true,
                onConfirm: () => remove(entry.id),
              });
            } : undefined}
          >
            <div className="card-name">{entry.name}</div>
            <div className="card-meta">{meta[entry.id]?.gone ? 'This list was deleted or no longer exists — tap to remove it.' : (meta[entry.id]?.text || '…')}</div>
          </Link>
        )) : (
          <div className="empty">
            <div className="big"><Icon name="cart" /></div>
            <p>No lists yet. Create one, then share the invite link or QR code with the people you shop with.</p>
            <Button variant="primary" onClick={openNewList}>Create your first list</Button>
          </div>
        )}
      </div>
      <section className="joinbox">
        <h2 className="sec-title">Have an invite?</h2>
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void inviteForm.handleSubmit(); }}>
          <FieldGroup className="contents">
          <inviteForm.Field name="invite">
            {(field) => (
              <Field className="field-control" data-invalid={field.state.meta.errors.length > 0}>
                <Input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="Paste invite link or code"
                  maxLength={300}
                  autoComplete="off"
                  aria-label="Invite link or code"
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <FieldError field={field} />
              </Field>
            )}
          </inviteForm.Field>
          </FieldGroup>
          <Button type="submit" variant="primary">Join</Button>
        </form>
      </section>
      <button className="fab" aria-label="New list" onClick={openNewList}><Icon name="plus" /><span>New list</span></button>
    </div>
  );
}
