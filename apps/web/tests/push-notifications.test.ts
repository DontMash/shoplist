import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationClickUrl } from '../src/lib/notification-click';
import {
  disableNotifications,
  enableNotifications,
  getNotificationStatus,
  muteNotifications,
  unmuteNotifications,
} from '../src/lib/push-notifications';

const status = { enabled: true, muted: false, available: true };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission: vi.fn() } });
});

describe('notification click routing', () => {
  it('opens a valid list route and safely falls back for malformed payloads', () => {
    expect(notificationClickUrl({ url: '/#/list/groceries' })).toBe('/#/list/groceries');
    expect(notificationClickUrl({ listId: 'groceries' })).toBe('/#/list/groceries');
    expect(notificationClickUrl({ listId: '../private' })).toBe('/');
    expect(notificationClickUrl(null)).toBe('/');
  });
});

describe('browser push adapter', () => {
  it('requests permission, registers a subscription, and enables a list destination', async () => {
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: 'https://push.example/subscription',
      toJSON: () => ({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'public', auth: 'auth' } }),
    });
    const getSubscription = vi.fn().mockResolvedValue(null);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) },
    });
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('granted');
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: 'BElongPublicKey' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => status });

    await expect(enableNotifications('list-1', 'client-1')).resolves.toEqual(status);
    expect(window.Notification.requestPermission).toHaveBeenCalledOnce();
    expect(getSubscription).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/lists/list-1/notifications', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ clientId: 'client-1', subscription: { endpoint: 'https://push.example/subscription', keys: { p256dh: 'public', auth: 'auth' } } }),
    }));
  });

  it('does not register a destination when permission is denied', async () => {
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('denied');
    await expect(enableNotifications('list-1', 'client-1')).rejects.toThrow('Notifications are blocked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads, mutes, unmutes, and disables a destination through the API', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => status })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, muted: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false, muted: false, available: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false, muted: false, available: true }) });

    await expect(getNotificationStatus('list-1', 'client-1')).resolves.toEqual(status);
    await expect(muteNotifications('list-1', 'client-1')).resolves.toMatchObject({ muted: true });
    await expect(unmuteNotifications('list-1', 'client-1')).resolves.toMatchObject({ muted: false });
    await expect(disableNotifications('list-1', 'client-1')).resolves.toMatchObject({ enabled: false });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/lists/list-1/notifications', expect.objectContaining({ method: 'PATCH' }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/lists/list-1/notifications', expect.objectContaining({ method: 'PATCH' }));
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/lists/list-1/notifications?client=client-1', expect.objectContaining({ method: 'DELETE' }));
  });
});
