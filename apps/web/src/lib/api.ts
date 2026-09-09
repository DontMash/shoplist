import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { transportContract, type TransportContract } from '@shoplist/transport-contract';
import { z } from 'zod';

const itemResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.string().default(''),
  collected: z.boolean().default(false),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  by: z.string().nullable().optional(),
  lastEditedBy: z.string().nullable().optional(),
});

const memberResponseSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  color: z.string(),
});

const listResponseSchema = z.object({
  list: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    revision: z.number().int().nonnegative().default(0),
  }),
  items: z.array(itemResponseSchema),
  members: z.array(memberResponseSchema).optional(),
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

const leaveListResponseSchema = z.object({ left: z.boolean() });

export type ListResponse = z.infer<typeof listResponseSchema>;
export type CreateListResponse = z.infer<typeof createListResponseSchema>;
export type ListResponseItem = ListResponse['items'][number];
export type ListResponseMember = z.infer<typeof memberResponseSchema>;

type TransportClient = ContractRouterClient<TransportContract>;
const rpcClient = createORPCClient<TransportClient>(new RPCLink({ url: '/rpc' }));

function rpcStatus(error: unknown): number {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status : 0;
}

function rpcMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'Request failed';
}

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
  try {
    return await rpcClient.list.get({ id }, { signal });
  } catch (error) {
    // Keep the old endpoint as a short-lived deployment fallback while an
    // already-open browser finishes upgrading to the current protocol.
    if (rpcStatus(error) >= 400 && rpcStatus(error) !== 404) throw new ApiError(rpcStatus(error), rpcMessage(error));
    const response = await fetch(`/api/lists/${encodeURIComponent(id)}`, { signal });
    return readResponse(response, listResponseSchema);
  }
}

export async function createList(name: string): Promise<CreateListResponse> {
  try {
    return await rpcClient.list.create({ name });
  } catch (error) {
    if (rpcStatus(error) >= 400 && rpcStatus(error) !== 404) throw new ApiError(rpcStatus(error), rpcMessage(error));
    const response = await fetch('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return readResponse(response, createListResponseSchema);
  }
}

export async function leaveList(listId: string, clientId: string): Promise<boolean> {
  try {
    return (await rpcClient.list.leave({ listId, clientId })).left;
  } catch (error) {
    if (rpcStatus(error) >= 400 && rpcStatus(error) !== 404) throw new ApiError(rpcStatus(error), rpcMessage(error));
    const response = await fetch(`/api/lists/${encodeURIComponent(listId)}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    return (await readResponse(response, leaveListResponseSchema)).left;
  }
}

/** Normalize a websocket full-state message into the same shape as REST data. */
export function responseFromSocket(
  message: { id: string; name: string; createdAt: number; revision?: number; items: ListResponseItem[]; members?: ListResponseMember[] },
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
    members: message.members ?? previous?.members,
    memberCount: previous?.memberCount,
  };
}

export const listQueryKey = (id: string) => ['lists', id] as const;
