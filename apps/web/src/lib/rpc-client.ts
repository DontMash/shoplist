import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { TransportContract } from '@shoplist/transport-contract';

/** Typed client for the native oRPC transport exposed at /rpc. */
export type TransportClient = ContractRouterClient<TransportContract>;

export const rpcClient: TransportClient = createORPCClient<TransportClient>(
  new RPCLink({
    url: () => new URL('/rpc', globalThis.location.href),
    // Resolve fetch at call time so tests and embedders can replace it.
    fetch: (request, init) => globalThis.fetch(request, init),
  }),
);
