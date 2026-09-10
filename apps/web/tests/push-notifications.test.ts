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

/** Minimal oRPC fetch response for the native transport. */
function rpcResponse(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify({ json: value }), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(call: [Request, RequestInit?]): string {
  return call[0].url;
}

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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ publicKey: 'BElongPublicKey' }))
      .mockResolvedValueOnce(rpcResponse(status));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enableNotifications('list-1', 'client-1')).resolves.toEqual(status);
    expect(window.Notification.requestPermission).toHaveBeenCalledOnce();
    expect(getSubscription).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }));

    const calls = fetchMock.mock.calls as Array<[Request, RequestInit?]>;
    expect(requestUrl(calls[0])).toContain('/rpc/push/config');
    expect(requestUrl(calls[1])).toContain('/rpc/push/register');
    expect(calls.every((call) => !requestUrl(call).includes('/api/'))).toBe(true);
    expect(JSON.parse(await calls[1][0].text())).toEqual({
      json: {
        listId: 'list-1',
        clientId: 'client-1',
        subscription: { endpoint: 'https://push.example/subscription', keys: { p256dh: 'public', auth: 'auth' } },
      },
    });
  });

  it('does not register a destination when permission is denied', async () => {
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('denied');
    await expect(enableNotifications('list-1', 'client-1')).rejects.toThrow('Notifications are blocked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads, mutes, unmutes, and disables a destination through the native transport', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rpcResponse(status))
      .mockResolvedValueOnce(rpcResponse({ ...status, muted: true }))
      .mockResolvedValueOnce(rpcResponse({ enabled: false, muted: false, available: true }))
      .mockResolvedValueOnce(rpcResponse({ enabled: false, muted: false, available: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNotificationStatus('list-1', 'client-1')).resolves.toEqual(status);
    await expect(muteNotifications('list-1', 'client-1')).resolves.toMatchObject({ muted: true });
    await expect(unmuteNotifications('list-1', 'client-1')).resolves.toMatchObject({ muted: false });
    await expect(disableNotifications('list-1', 'client-1')).resolves.toMatchObject({ enabled: false });

    const calls = fetchMock.mock.calls as Array<[Request, RequestInit?]>;
    expect(calls.map(requestUrl)).toEqual([
      expect.stringContaining('/rpc/push/status'),
      expect.stringContaining('/rpc/push/mute'),
      expect.stringContaining('/rpc/push/mute'),
      expect.stringContaining('/rpc/push/remove'),
    ]);
    expect(JSON.parse(await calls[1][0].text())).toEqual({ json: { listId: 'list-1', clientId: 'client-1', muted: true } });
    expect(JSON.parse(await calls[2][0].text())).toEqual({ json: { listId: 'list-1', clientId: 'client-1', muted: false } });
    expect(calls.every((call) => !requestUrl(call).includes('/api/'))).toBe(true);
  });

  it('reports transport failures and malformed status payloads safely', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rpcResponse({ enabled: 'yes' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getNotificationStatus('list-1', 'client-1')).rejects.toThrow('The server returned invalid notification settings.');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(muteNotifications('list-1', 'client-1')).rejects.toThrow('Notification settings could not be saved.');
  });
});
