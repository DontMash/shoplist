import { rpcClient } from './rpc-client';

export interface NotificationStatus {
  enabled: boolean;
  muted: boolean;
  available: boolean;
}

interface SubscriptionJson {
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
}

function ensureStatus(value: unknown): NotificationStatus {
  if (!value || typeof value !== 'object') throw new Error('The server returned invalid notification settings.');
  const status = value as Partial<NotificationStatus>;
  if (typeof status.enabled !== 'boolean' || typeof status.muted !== 'boolean' || typeof status.available !== 'boolean') {
    throw new Error('The server returned invalid notification settings.');
  }
  return status as NotificationStatus;
}

function decodePublicKey(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function subscriptionJson(subscription: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const value = subscription.toJSON() as SubscriptionJson;
  const endpoint = value.endpoint || subscription.endpoint;
  const p256dh = value.keys?.p256dh || '';
  const auth = value.keys?.auth || '';
  if (!endpoint || !p256dh || !auth) throw new Error('The browser returned an invalid notification subscription.');
  return { endpoint, keys: { p256dh, auth } };
}

async function statusOrThrow(request: Promise<unknown>): Promise<NotificationStatus> {
  let value: unknown;
  try {
    value = await request;
  } catch {
    throw new Error('Notification settings could not be saved.');
  }
  return ensureStatus(value);
}

export function getNotificationStatus(listId: string, clientId: string): Promise<NotificationStatus> {
  return statusOrThrow(rpcClient.push.status({ listId, clientId }));
}

export async function enableNotifications(listId: string, clientId: string): Promise<NotificationStatus> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported in this browser.');
  }

  // Request permission before the first await so the browser can associate the
  // prompt with the explicit list-menu action that initiated it.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');
  const config = await rpcClient.push.config({});
  if (!config.publicKey) throw new Error('Push notifications are not configured on this Shoplist server.');
  const registration = await navigator.serviceWorker.ready;
  if (!registration.pushManager) throw new Error('Push notifications are not supported in this browser.');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodePublicKey(config.publicKey) as unknown as BufferSource,
  });
  return statusOrThrow(rpcClient.push.register({
    listId,
    clientId,
    subscription: subscriptionJson(subscription),
  }));
}

function updateMuted(listId: string, clientId: string, muted: boolean): Promise<NotificationStatus> {
  return statusOrThrow(rpcClient.push.mute({ listId, clientId, muted }));
}

export function muteNotifications(listId: string, clientId: string): Promise<NotificationStatus> {
  return updateMuted(listId, clientId, true);
}

export function unmuteNotifications(listId: string, clientId: string): Promise<NotificationStatus> {
  return updateMuted(listId, clientId, false);
}

export function disableNotifications(listId: string, clientId: string): Promise<NotificationStatus> {
  return statusOrThrow(rpcClient.push.remove({ listId, clientId }));
}
