import { useEffect } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { DialogHost } from './components/dialog-host';
import { NotificationToaster, notify } from './components/notification-toaster';
import { HomePage } from './pages/home-page';
import { JoinPage } from './pages/join-page';
import { ListPage } from './pages/list-page';
import { useDialogStore } from './stores/dialog-store';
import { useSavedListsStore } from './stores/saved-lists-store';

export function App() {
  const [route] = useLocation();
  const lists = useSavedListsStore((state) => state.lists);
  const closeDialog = useDialogStore((state) => state.closeDialog);

  useEffect(() => {
    closeDialog();
  }, [closeDialog, route]);

  useEffect(() => {
    const online = () => notify('Back online');
    const offline = () => notify('You are offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  return (
    <NotificationToaster>
      <main id="app">
        <Switch>
          <Route path="/list/:id">
            {({ id }: { id: string }) => lists.some((entry) => entry.id === id) ? <ListPage id={id} /> : <JoinPage id={id} />}
          </Route>
          <Route path="/join/:id">
            {({ id }: { id: string }) => <JoinPage id={id} />}
          </Route>
          <Route>
            <HomePage />
          </Route>
        </Switch>
      </main>
      <DialogHost />
    </NotificationToaster>
  );
}
