import webpush from 'web-push';
import type { PushDestination, Store } from './store.js';

export type NotificationEvent = {
  listId: string;
  listName: string;
  actorClientId: string;
  actorName: string;
  kind: 'join' | 'changed' | 'clear' | 'rename' | 'delete';
};

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushSender {
  send(destination: PushDestination, payload: NotificationPayload): Promise<void>;
}

export class WebPushSender implements PushSender {
  public constructor(publicKey: string, privateKey: string, subject: string) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  public async send(destination: PushDestination, payload: NotificationPayload): Promise<void> {
    await webpush.sendNotification({
      endpoint: destination.endpoint,
      keys: destination.keys,
    }, JSON.stringify(payload));
  }
}

export function notificationPayload(event: NotificationEvent): NotificationPayload {
  const actor = event.actorName || 'Someone';
  const action = event.kind === 'join' ? 'joined'
    : event.kind === 'changed' ? 'updated'
      : event.kind === 'clear' ? 'cleared'
        : event.kind === 'rename' ? 'renamed'
          : 'deleted';
  return {
    title: 'Shoplist',
    body: `${actor} ${action} ${event.listName}`,
    url: `/#/list/${encodeURIComponent(event.listId)}`,
    tag: `shoplist-${event.listId}`,
  };
}

export function onlineClientIds(rooms: Map<string, Map<unknown, { clientId: string }>>, listId: string): Set<string> {
  return new Set([...rooms.get(listId)?.values() || []].map((client) => client.clientId));
}

export async function sendNotification(
  store: Store,
  sender: PushSender | undefined,
  event: NotificationEvent,
  online: Set<string>,
  capturedRecipients?: PushDestination[],
): Promise<void> {
  if (!sender) return;
  const payload = notificationPayload(event);
  const excluded = new Set(online);
  excluded.add(event.actorClientId);
  const recipients = (capturedRecipients || store.getNotificationRecipients(event.listId, excluded))
    .filter((destination) => !excluded.has(destination.clientId));
  await Promise.all(recipients.map(async (destination) => {
    try {
      await sender.send(destination, payload);
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) {
        store.removePushDestination(event.listId, destination.clientId, destination.endpoint);
      } else {
        console.error('[push] delivery failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }));
}

export interface NotificationDispatcherOptions {
  coalesceMs?: number;
}

export class NotificationDispatcher {
  private readonly pending = new Map<string, { event: NotificationEvent; timer: ReturnType<typeof setTimeout> }>();
  private readonly coalesceMs: number;

  public constructor(
    private readonly store: Store,
    private readonly sender: PushSender | undefined,
    private readonly onlineFor: (listId: string) => Set<string>,
    options: NotificationDispatcherOptions = {},
  ) {
    this.coalesceMs = options.coalesceMs ?? 30_000;
  }

  public dispatch(event: NotificationEvent, capturedRecipients?: PushDestination[]): Promise<void> {
    if (!this.sender) return Promise.resolve();
    if (event.kind === 'join' || event.kind === 'delete' || this.coalesceMs <= 0) {
      if (event.kind === 'delete') {
        const pending = this.pending.get(event.listId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(event.listId);
        }
      }
      return sendNotification(this.store, this.sender, event, this.onlineFor(event.listId), capturedRecipients);
    }

    const previous = this.pending.get(event.listId);
    if (previous) clearTimeout(previous.timer);
    const nextEvent: NotificationEvent = previous
      ? { ...event, actorName: 'Several people', actorClientId: '' }
      : event;
    const timer = setTimeout(() => {
      this.pending.delete(event.listId);
      void sendNotification(this.store, this.sender, nextEvent, this.onlineFor(event.listId));
    }, this.coalesceMs);
    this.pending.set(event.listId, { event: nextEvent, timer });
    return Promise.resolve();
  }

  public dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
