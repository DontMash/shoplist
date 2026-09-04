import { useEffect, useRef, type ReactNode } from 'react';
import { Toaster, toast } from './ui/toast';
import { useNotificationStore } from '../stores/notification-store';

/**
 * Zustand owns the app-level notification queue; Base UI owns the accessible
 * live region, stacking, swipe dismissal, and timeout animation.
 */
function NotificationBridge() {
  const notifications = useNotificationStore((state) => state.notifications);
  const dismissNotification = useNotificationStore((state) => state.dismissNotification);
  const renderedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const activeIds = new Set(notifications.map((notification) => notification.id));
    for (const id of renderedIds.current) {
      if (!activeIds.has(id)) toast.close(id);
    }
    for (const notification of notifications) {
      toast.add({
        id: notification.id,
        title: notification.message,
        timeout: notification.duration,
        onRemove: () => dismissNotification(notification.id),
      });
    }
    renderedIds.current = activeIds;
  }, [dismissNotification, notifications]);

  return null;
}

export function NotificationToaster({ children }: { children: ReactNode }) {
  return <Toaster><NotificationBridge />{children}</Toaster>;
}

export function notify(message: string): void {
  useNotificationStore.getState().addNotification(message);
}
