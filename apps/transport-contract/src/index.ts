import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';

/** The version understood by the current browser and server pair. */
export const PROTOCOL_VERSION = 1 as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  amount: z.string(),
  collected: z.boolean(),
  createdAt: z.number().finite().optional(),
  updatedAt: z.number().finite().optional(),
  by: z.string().nullable().optional(),
  lastEditedBy: z.string().nullable().optional(),
});

export const participantSchema = z.object({
  clientId: z.string().min(1),
  name: z.string(),
  color: z.string(),
});

export const listMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
});

export const listSnapshotSchema = z.object({
  list: listMetadataSchema,
  items: z.array(itemSchema),
  members: z.array(participantSchema),
  memberCount: z.number().int().nonnegative().optional(),
});

export const structuredFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
});

export const transportErrorSchema = z.object({
  defined: z.boolean(),
  code: z.string(),
  status: z.number().int().nonnegative(),
  message: z.string(),
  data: structuredFailureSchema.optional(),
});

export const mutationInputSchema = z.object({
  listId: z.string().min(1),
  sessionId: z.string().min(1),
  clientId: z.string().min(1),
  operationId: z.string().min(1).max(160),
});

export const mutationAckSchema = z.object({
  protocolVersion: protocolVersionSchema,
  operationId: z.string().min(1),
  status: z.enum(['accepted', 'rejected']),
  revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
  message: z.string().optional(),
  item: itemSchema.optional(),
  itemId: z.string().min(1).optional(),
  tempItemId: z.string().min(1).optional(),
  idMap: z.object({ tempId: z.string().min(1), itemId: z.string().min(1) }).optional(),
});

export const listGetOutputSchema = z.object({
  list: listMetadataSchema,
  items: z.array(itemSchema),
  members: z.array(participantSchema),
  memberCount: z.number().int().nonnegative(),
});

export const createListOutputSchema = z.object({
  list: listMetadataSchema,
  ownerToken: z.string().min(1),
});

export const listSessionOpenOutputSchema = z.object({
  protocolVersion: protocolVersionSchema,
  sessionId: z.string().min(1),
  you: participantSchema,
  snapshot: listSnapshotSchema,
  online: z.array(participantSchema),
  eventCursor: z.string().min(1),
});

export const stateEventSchema = z.object({
  kind: z.literal('state'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1),
  snapshot: listSnapshotSchema,
  actor: participantSchema.nullable(),
});

export const presenceEventSchema = z.object({
  kind: z.literal('presence'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1),
  online: z.array(participantSchema),
  members: z.array(participantSchema),
});

export const listClosedEventSchema = z.object({
  kind: z.literal('list-closed'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1),
  reason: z.literal('deleted'),
});

export const upgradeRequiredEventSchema = z.object({
  kind: z.literal('upgrade-required'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1),
  message: z.string(),
});

export const sessionEventSchema = z.discriminatedUnion('kind', [
  stateEventSchema,
  presenceEventSchema,
  listClosedEventSchema,
  upgradeRequiredEventSchema,
]);

const operationErrors = {
  BAD_REQUEST: { status: 400, data: structuredFailureSchema },
  FORBIDDEN: { status: 403, data: structuredFailureSchema },
  NOT_FOUND: { status: 404, data: structuredFailureSchema },
  CONFLICT: { status: 409, data: structuredFailureSchema },
  INTERNAL_SERVER_ERROR: { status: 500, data: structuredFailureSchema },
  UPGRADE_REQUIRED: { status: 426, data: structuredFailureSchema },
} as const;

const listGet = oc
  .route({ path: '/list/get', method: 'POST', operationId: 'list.get' })
  .input(z.object({ id: z.string().min(1) }))
  .output(listGetOutputSchema)
  .errors(operationErrors);

const listCreate = oc
  .route({ path: '/list/create', method: 'POST', operationId: 'list.create', successStatus: 201 })
  .input(z.object({ name: z.string().optional() }))
  .output(createListOutputSchema)
  .errors(operationErrors);

const listLeave = oc
  .route({ path: '/list/leave', method: 'POST', operationId: 'list.leave' })
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ left: z.boolean() }))
  .errors(operationErrors);

const pushConfig = oc
  .route({ path: '/push/config', method: 'POST', operationId: 'push.config' })
  .input(z.object({}))
  .output(z.object({ publicKey: z.string().nullable(), available: z.boolean() }))
  .errors(operationErrors);

const pushStatus = oc
  .route({ path: '/push/status', method: 'POST', operationId: 'push.status' })
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushRegister = oc
  .route({ path: '/push/register', method: 'POST', operationId: 'push.register' })
  .input(z.object({
    listId: z.string().min(1),
    clientId: z.string().min(1),
    subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushMute = oc
  .route({ path: '/push/mute', method: 'POST', operationId: 'push.mute' })
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1), muted: z.boolean() }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushRemove = oc
  .route({ path: '/push/remove', method: 'POST', operationId: 'push.remove' })
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const qrGenerate = oc
  .route({ path: '/qr/generate', method: 'POST', operationId: 'qr.generate' })
  .input(z.object({ data: z.string().min(1).max(512) }))
  .output(z.object({ svg: z.string().min(1) }))
  .errors(operationErrors);

const listSessionOpen = oc
  .route({ path: '/listSession/open', method: 'POST', operationId: 'listSession.open' })
  .input(z.object({
    listId: z.string().min(1),
    clientId: z.string().min(1),
    name: z.string().optional(),
    protocolVersion: z.number().int().nonnegative(),
  }))
  .output(listSessionOpenOutputSchema)
  .errors(operationErrors);

const listSessionEvents = oc
  .route({ path: '/listSession/events', method: 'POST', operationId: 'listSession.events' })
  .input(z.object({ listId: z.string().min(1), sessionId: z.string().min(1), cursor: z.string().optional() }))
  .output(eventIterator(sessionEventSchema))
  .errors(operationErrors);

const itemAdd = oc
  .route({ path: '/item/add', method: 'POST', operationId: 'item.add' })
  .input(mutationInputSchema.extend({ name: z.string(), amount: z.string().optional(), tempItemId: z.string().optional() }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const itemUpdate = oc
  .route({ path: '/item/update', method: 'POST', operationId: 'item.update' })
  .input(mutationInputSchema.extend({ id: z.string().min(1), patch: z.object({ name: z.string().optional(), amount: z.string().optional(), collected: z.boolean().optional() }) }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const itemDelete = oc
  .route({ path: '/item/delete', method: 'POST', operationId: 'item.delete' })
  .input(mutationInputSchema.extend({ id: z.string().min(1) }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const listClear = oc
  .route({ path: '/list/clear', method: 'POST', operationId: 'list.clear' })
  .input(mutationInputSchema)
  .output(mutationAckSchema)
  .errors(operationErrors);

const listRename = oc
  .route({ path: '/list/rename', method: 'POST', operationId: 'list.rename' })
  .input(mutationInputSchema.extend({ name: z.string() }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const listDelete = oc
  .route({ path: '/list/delete', method: 'POST', operationId: 'list.delete' })
  .input(mutationInputSchema.extend({ ownerToken: z.string() }))
  .output(mutationAckSchema)
  .errors(operationErrors);

export const transportContract = oc.router({
  list: { get: listGet, create: listCreate, leave: listLeave, clear: listClear, rename: listRename, delete: listDelete },
  push: { config: pushConfig, status: pushStatus, register: pushRegister, mute: pushMute, remove: pushRemove },
  qr: { generate: qrGenerate },
  listSession: { open: listSessionOpen, events: listSessionEvents },
  item: { add: itemAdd, update: itemUpdate, delete: itemDelete },
});

export type Item = z.infer<typeof itemSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ListMetadata = z.infer<typeof listMetadataSchema>;
export type ListSnapshot = z.infer<typeof listSnapshotSchema>;
export type MutationAck = z.infer<typeof mutationAckSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type TransportError = z.infer<typeof transportErrorSchema>;
export type ListSessionOpenOutput = z.infer<typeof listSessionOpenOutputSchema>;
export type TransportContract = typeof transportContract;
export type TransportErrorCode = keyof typeof operationErrors;

export {
  itemAdd,
  itemDelete,
  itemUpdate,
  listClear,
  listCreate,
  listDelete,
  listGet,
  listLeave,
  listRename,
  listSessionEvents,
  listSessionOpen,
  operationErrors,
  pushConfig,
  pushMute,
  pushRegister,
  pushRemove,
  pushStatus,
  qrGenerate,
};
