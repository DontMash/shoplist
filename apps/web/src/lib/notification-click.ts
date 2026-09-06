const LIST_ID = /^[A-Za-z0-9_-]{4,40}$/;
const LIST_ROUTE = /^\/#\/list\/([A-Za-z0-9_-]{4,40})$/;

export function notificationClickUrl(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '/';
  const value = data as { url?: unknown; listId?: unknown };
  if (typeof value.url === 'string' && LIST_ROUTE.test(value.url)) return value.url;
  if (typeof value.listId === 'string' && LIST_ID.test(value.listId)) return `/#/list/${value.listId}`;
  return '/';
}
