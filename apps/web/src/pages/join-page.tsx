import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Link, useLocation } from 'wouter';
import { Button } from '../components/ui/button';
import { Field, FieldGroup } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { FieldError } from '../components/shared/field-error';
import { Icon } from '../components/shared/icon';
import { ApiError, fetchList, listQueryKey } from '../lib/api';
import { displayNameSchema } from '../lib/schemas';
import { useParticipantStore } from '../stores/participant-store';
import { useSavedListsStore } from '../stores/saved-lists-store';

export function JoinPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const identity = useParticipantStore((state) => state.identity);
  const setName = useParticipantStore((state) => state.setName);
  const lists = useSavedListsStore((state) => state.lists);
  const upsertList = useSavedListsStore((state) => state.upsertList);
  const query = useQuery({
    queryKey: listQueryKey(id),
    queryFn: ({ signal }) => fetchList(id, signal),
    staleTime: 30_000,
    retry: false,
  });
  const meta = query.data;
  const joinForm = useForm({
    defaultValues: { name: identity.name || '' },
    validators: { onChange: displayNameSchema, onSubmit: displayNameSchema },
    onSubmit: ({ value }) => {
      if (!meta) return;
      const nextName = value.name.trim();
      setName(nextName);
      const existing = lists.find((item) => item.id === id);
      upsertList({ id, name: meta.list.name, ownerToken: existing?.ownerToken || null, joinedAt: Date.now() });
      queryClient.setQueryData(listQueryKey(id), meta);
      navigate(`/list/${id}`);
    },
  });

  const error = query.error instanceof ApiError && query.error.status === 404
    ? 'This invite is not valid — the list doesn\'t exist (anymore).'
    : query.isError ? 'You seem to be offline. Reconnect to join this list.' : '';

  return (
    <div className="center-page">
      <div className="join-card">
        <div className="big"><Icon name="cart" /></div>
        <h1>{meta ? `Join “${meta.list.name}”` : 'Join list'}</h1>
        <p className="muted">{error || (query.isPending ? 'Loading…' : meta?.memberCount && meta.memberCount > 0 ? `${meta.memberCount} ${meta.memberCount === 1 ? 'person has' : 'people have'} this list on their device. No account needed — pick a name and jump in.` : 'No account needed — pick a name and jump in.')}</p>
        {meta && (
          <form className="stack" onSubmit={(event) => { event.preventDefault(); void joinForm.handleSubmit(); }}>
            <FieldGroup className="contents">
            <joinForm.Field name="name">
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <Input
                    autoFocus={!identity.name}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="Your name"
                    maxLength={40}
                    aria-label="Your name"
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldError field={field} />
                </Field>
              )}
            </joinForm.Field>
            </FieldGroup>
            <Button type="submit" variant="primary">Join list</Button>
          </form>
        )}
        <Link className="backlink" href="/">Go to my lists</Link>
      </div>
    </div>
  );
}
