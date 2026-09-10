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
  revision: z.number().int().nonnegative().describe('Durable version of the accepted list state, advanced once per committed mutation.'),
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
  eventCursor: z.string().min(1).describe('Delivery cursor for the event stream. It tracks delivery progress and is not a list revision.'),
});

export const stateEventSchema = z.object({
  kind: z.literal('state'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1).describe('Delivery cursor for resuming the event stream. It is not a list revision.'),
  snapshot: listSnapshotSchema,
  actor: participantSchema.nullable(),
});

export const presenceEventSchema = z.object({
  kind: z.literal('presence'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1).describe('Delivery cursor for resuming the event stream. It is not a list revision.'),
  online: z.array(participantSchema),
  members: z.array(participantSchema),
});

export const listClosedEventSchema = z.object({
  kind: z.literal('list-closed'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1).describe('Delivery cursor for resuming the event stream. It is not a list revision.'),
  reason: z.literal('deleted'),
});

export const upgradeRequiredEventSchema = z.object({
  kind: z.literal('upgrade-required'),
  protocolVersion: protocolVersionSchema,
  eventCursor: z.string().min(1).describe('Delivery cursor for resuming the event stream. It is not a list revision.'),
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

/** Build a procedure route together with the OpenAPI metadata it exposes. */
function procedureRoute(config: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: `/${string}`;
  operationId: string;
  summary: string;
  description?: string;
  successStatus?: number;
}) {
  return oc.route(config);
}

const listGet = procedureRoute({
  method: 'GET',
  path: '/list/get',
  operationId: 'list.get',
  summary: 'Read a list',
  description: 'Returns list metadata, items, and members together with the durable list revision.',
})
  .input(z.object({ id: z.string().min(1) }))
  .output(listGetOutputSchema)
  .errors(operationErrors);

const listCreate = procedureRoute({
  method: 'POST',
  path: '/list/create',
  operationId: 'list.create',
  summary: 'Create a list',
  description: 'Creates a list and returns the owner token required to delete it.',
  successStatus: 201,
})
  .input(z.object({ name: z.string().optional() }))
  .output(createListOutputSchema)
  .errors(operationErrors);

const listLeave = procedureRoute({
  method: 'DELETE',
  path: '/list/leave',
  operationId: 'list.leave',
  summary: 'Leave a list',
  description: 'Ends a participant membership without changing the list revision.',
})
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ left: z.boolean() }))
  .errors(operationErrors);

const pushConfig = procedureRoute({
  method: 'GET',
  path: '/push/config',
  operationId: 'push.config',
  summary: 'Read push configuration',
  description: 'Returns the public push key when the server can deliver list activity notifications.',
})
  .input(z.object({}))
  .output(z.object({ publicKey: z.string().nullable(), available: z.boolean() }))
  .errors(operationErrors);

const pushStatus = procedureRoute({
  method: 'GET',
  path: '/push/status',
  operationId: 'push.status',
  summary: 'Read push status',
  description: 'Returns whether a participant has an active push destination for a list.',
})
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushRegister = procedureRoute({
  method: 'POST',
  path: '/push/register',
  operationId: 'push.register',
  summary: 'Register a push destination',
  description: 'Authorizes one browser installation to receive list activity notifications.',
})
  .input(z.object({
    listId: z.string().min(1),
    clientId: z.string().min(1),
    subscription: z.object({
      endpoint: z.string().url().max(2048).startsWith('https://', 'Push endpoints must use https'),
      keys: z.object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      }),
    }),
  }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushMute = procedureRoute({
  method: 'PATCH',
  path: '/push/mute',
  operationId: 'push.mute',
  summary: 'Mute push notifications',
  description: 'Mutes or unmutes list activity notifications for one push destination.',
})
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1), muted: z.boolean() }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const pushRemove = procedureRoute({
  method: 'DELETE',
  path: '/push/remove',
  operationId: 'push.remove',
  summary: 'Remove a push destination',
  description: 'Stops list activity notifications for one participant.',
})
  .input(z.object({ listId: z.string().min(1), clientId: z.string().min(1) }))
  .output(z.object({ enabled: z.boolean(), muted: z.boolean(), available: z.boolean() }))
  .errors(operationErrors);

const qrGenerate = procedureRoute({
  method: 'GET',
  path: '/qr/generate',
  operationId: 'qr.generate',
  summary: 'Generate a QR code',
  description: 'Renders invite data as an SVG QR code.',
})
  .input(z.object({ data: z.string().min(1).max(512) }))
  .output(z.object({ svg: z.string().min(1) }))
  .errors(operationErrors);

const listSessionOpen = procedureRoute({
  method: 'POST',
  path: '/listSession/open',
  operationId: 'listSession.open',
  summary: 'Open a list session',
  description: 'Establishes or resumes a participant list session and returns the bootstrap snapshot, presence, and delivery cursor.',
})
  .input(z.object({
    listId: z.string().min(1),
    clientId: z.string().min(1),
    name: z.string().optional(),
    protocolVersion: z.number().int().nonnegative(),
  }))
  .output(listSessionOpenOutputSchema)
  .errors(operationErrors);

const listSessionEvents = procedureRoute({
  method: 'GET',
  path: '/listSession/events',
  operationId: 'listSession.events',
  summary: 'Stream list-session events',
  description: [
    'Server-sent event stream of list-session updates, encoded as an event iterator.',
    'The event cursor is delivery metadata used to resume the stream; durable list state is fenced',
    'by the snapshot list revision, and participant mutations remain identified by Operation IDs.',
    'A list-closed event completes the stream after a terminal list deletion.',
  ].join(' '),
})
  .input(z.object({
    listId: z.string().min(1),
    sessionId: z.string().min(1),
    cursor: z.string().optional().describe('Delivery cursor to resume after. It is not a list revision.'),
  }))
  .output(eventIterator(sessionEventSchema))
  .errors(operationErrors);

const itemAdd = procedureRoute({
  method: 'POST',
  path: '/item/add',
  operationId: 'item.add',
  summary: 'Add an item',
  description: 'Applies one identified item mutation and acknowledges the durable list revision.',
})
  .input(mutationInputSchema.extend({ name: z.string(), amount: z.string().optional(), tempItemId: z.string().optional() }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const itemUpdate = procedureRoute({
  method: 'PATCH',
  path: '/item/update',
  operationId: 'item.update',
  summary: 'Update an item',
  description: 'Applies one identified item patch and acknowledges the durable list revision.',
})
  .input(mutationInputSchema.extend({ id: z.string().min(1), patch: z.object({ name: z.string().optional(), amount: z.string().optional(), collected: z.boolean().optional() }) }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const itemDelete = procedureRoute({
  method: 'DELETE',
  path: '/item/delete',
  operationId: 'item.delete',
  summary: 'Delete an item',
  description: 'Applies one identified item deletion and acknowledges the durable list revision.',
})
  .input(mutationInputSchema.extend({ id: z.string().min(1) }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const listClear = procedureRoute({
  method: 'DELETE',
  path: '/list/clear',
  operationId: 'list.clear',
  summary: 'Clear a list',
  description: 'Applies one identified clear mutation and acknowledges the durable list revision.',
})
  .input(mutationInputSchema)
  .output(mutationAckSchema)
  .errors(operationErrors);

const listRename = procedureRoute({
  method: 'PATCH',
  path: '/list/rename',
  operationId: 'list.rename',
  summary: 'Rename a list',
  description: 'Applies one identified rename mutation and acknowledges the durable list revision.',
})
  .input(mutationInputSchema.extend({ name: z.string() }))
  .output(mutationAckSchema)
  .errors(operationErrors);

const listDelete = procedureRoute({
  method: 'DELETE',
  path: '/list/delete',
  operationId: 'list.delete',
  summary: 'Delete a list',
  description: 'Deletes a list when the owner token matches and acknowledges the terminal list revision.',
})
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
