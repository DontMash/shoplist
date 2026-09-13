import type { NotificationEvent, NotificationDispatcher } from './notifications.js';
import type { OperationKind, OperationResult, PushDestination, StoreOperation } from './store.js';
import { runListMutation, type ProcessLayer } from './effect/services.js';

export interface MutationActor {
  readonly clientId: string;
  readonly name: string;
  readonly color: string;
}

export interface MutationSession {
  readonly sessionId: string;
  readonly listId: string;
  readonly clientId: string;
  readonly name: string;
  readonly participant: MutationActor;
}

export interface MutationSessionRegistry {
  get(sessionId: string): MutationSession | undefined;
}

/** Application-level effects coordinated after a list mutation commits. */
export interface ListMutationEffects {
  publishState(listId: string, result: OperationResult, actor: MutationActor): void;
  publishClosed(listId: string): void;
  closePublisher(listId: string): void;
  closeSessions(listId: string): void;
}

export interface ListMutationWorkflowDependencies {
  readonly sessions: MutationSessionRegistry;
  readonly dispatcher: NotificationDispatcher;
  readonly effectLayer: ProcessLayer;
  readonly protocolVersion: number;
  readonly effects: ListMutationEffects;
}

export interface ListMutationInput {
  readonly listId: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly payload: Record<string, unknown>;
}

export interface ListMutationWorkflow {
  apply(input: ListMutationInput): Promise<OperationResult>;
}

export class InactiveListSessionError extends Error {
  public readonly code = 'FORBIDDEN' as const;

  public constructor() {
    super('The list session is not active.');
    this.name = 'InactiveListSessionError';
  }
}

function activeSession(
  sessions: MutationSessionRegistry,
  listId: string,
  sessionId: string,
  clientId: string,
): MutationSession {
  const session = sessions.get(sessionId);
  if (!session || session.listId !== listId || session.clientId !== clientId) {
    throw new InactiveListSessionError();
  }
  return session;
}

function logSecondaryFailure(description: string, error: unknown): void {
  console.error(`[list-mutation] ${description} failed:`, error);
}

function runSecondaryEffect(description: string, effect: () => void): void {
  try {
    effect();
  } catch (error) {
    logSecondaryFailure(description, error);
  }
}

function handOffNotification(
  dispatcher: NotificationDispatcher,
  event: NotificationEvent,
  recipients: PushDestination[] | undefined,
): void {
  try {
    void dispatcher.dispatch(event, recipients).catch((error: unknown) => {
      logSecondaryFailure('notification dispatch', error);
    });
  } catch (error) {
    logSecondaryFailure('notification dispatch', error);
  }
}

/** Coordinates one participant-requested list mutation across its adapters. */
export function createListMutationWorkflow(
  dependencies: ListMutationWorkflowDependencies,
): ListMutationWorkflow {
  return {
    async apply(input): Promise<OperationResult> {
      const session = activeSession(dependencies.sessions, input.listId, input.sessionId, input.clientId);
      const operation: StoreOperation = {
        operationId: input.operationId,
        kind: input.kind,
        payload: input.payload,
        actorClientId: session.clientId,
        actorName: session.name,
        protocolVersion: dependencies.protocolVersion,
      };
      const result = await runListMutation(dependencies.effectLayer, input.listId, operation);

      if (result.duplicate) return result;

      // Durable persistence has committed. Secondary effects must not turn an
      // accepted acknowledgement into a rejection.
      if (result.terminal) {
        runSecondaryEffect('terminal outcome publication', () => dependencies.effects.publishClosed(input.listId));
        runSecondaryEffect('publisher cleanup', () => dependencies.effects.closePublisher(input.listId));
        runSecondaryEffect('list-session cleanup', () => dependencies.effects.closeSessions(input.listId));
      } else if (result.ack.status === 'accepted' && result.list) {
        runSecondaryEffect('state publication', () => dependencies.effects.publishState(input.listId, result, session.participant));
      }

      if (result.notification) {
        handOffNotification(dependencies.dispatcher, result.notification, result.notificationRecipients);
      }
      return result;
    },
  };
}
