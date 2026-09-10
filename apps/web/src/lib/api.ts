import type { Item, ListMetadata, Participant } from '@shoplist/transport-contract';
import { rpcClient } from './rpc-client';

export type ListResponseItem = Item;
export type ListResponseMember = Participant;

export interface ListResponse {
  list: ListMetadata;
  items: ListResponseItem[];
  members?: ListResponseMember[];
  memberCount?: number;
}

export interface CreateListResponse {
  list: ListMetadata;
  ownerToken: string;
}

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

async function rpcCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ApiError(rpcStatus(error), rpcMessage(error));
  }
}

export function fetchList(id: string, signal?: AbortSignal): Promise<ListResponse> {
  return rpcCall(() => rpcClient.list.get({ id }, { signal }));
}

export function createList(name: string): Promise<CreateListResponse> {
  return rpcCall(() => rpcClient.list.create({ name }));
}

export async function leaveList(listId: string, clientId: string): Promise<boolean> {
  return (await rpcCall(() => rpcClient.list.leave({ listId, clientId }))).left;
}

export const listQueryKey = (id: string) => ['lists', id] as const;
