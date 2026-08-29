import { z } from 'zod';

const itemResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.string().default(''),
  collected: z.boolean().default(false),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  by: z.string().nullable().optional(),
});

const listResponseSchema = z.object({
  list: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    revision: z.number().int().nonnegative().default(0),
  }),
  items: z.array(itemResponseSchema),
  memberCount: z.number().int().nonnegative().optional(),
});

const createListResponseSchema = z.object({
  list: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    revision: z.number().int().nonnegative().default(0),
  }),
  ownerToken: z.string(),
});

export type ListResponse = z.infer<typeof listResponseSchema>;
export type CreateListResponse = z.infer<typeof createListResponseSchema>;
export type ListResponseItem = ListResponse['items'][number];

/** Errors retain the HTTP status so query consumers can distinguish 404s. */
export class ApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message = 'Request failed') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new ApiError(response.status);
  try {
    return schema.parse(await response.json());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('The server returned an invalid response');
  }
}

export async function fetchList(id: string, signal?: AbortSignal): Promise<ListResponse> {
  const response = await fetch(`/api/lists/${encodeURIComponent(id)}`, { signal });
  return readResponse(response, listResponseSchema);
}

export async function createList(name: string): Promise<CreateListResponse> {
  const response = await fetch('/api/lists', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readResponse(response, createListResponseSchema);
}

/** Normalize a websocket full-state message into the same shape as REST data. */
export function responseFromSocket(
  message: { id: string; name: string; createdAt: number; revision?: number; items: ListResponseItem[] },
  previous?: ListResponse,
): ListResponse {
  return {
    list: {
      id: message.id,
      name: message.name,
      createdAt: message.createdAt,
      revision: message.revision ?? previous?.list.revision ?? 0,
    },
    items: message.items,
    memberCount: previous?.memberCount,
  };
}

export const listQueryKey = (id: string) => ['lists', id] as const;
