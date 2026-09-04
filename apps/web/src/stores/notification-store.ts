import { create } from 'zustand';
import { uid } from '../lib/list';

export interface Notification {
  id: string;
  message: string;
  duration: number;
}

interface NotificationStore {
  notifications: Notification[];
  addNotification: (message: string, duration?: number) => string;
  dismissNotification: (id: string) => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (message, duration = 3000) => {
    const id = uid();
    set((state) => ({
      notifications: [...state.notifications, { id, message, duration }],
    }));
    return id;
  },
  dismissNotification: (id) => set((state) => ({
    notifications: state.notifications.filter((notification) => notification.id !== id),
  })),
}));
