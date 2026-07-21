import type { BoardErrorV1, BoardId } from '@sceneboard/board-schema';

import type {
  BoardIncrementalDurableEnvelopeV1,
  BoardRevisionHintEnvelopeV1,
  BoardRevisionSnapshotAdmissionV1,
} from '../events/index.js';

export type BoardStreamPresenceStateV1 = 'online' | 'away';

export type BoardStreamOpenInputV1 = {
  apiOrigin: string;
  boardId: BoardId;
  tabId: string;
  presenceState: BoardStreamPresenceStateV1;
  cursor: string | null;
  signal: AbortSignal;
};

export type BoardStreamDispatchResultV1<T> =
  | { kind: 'consumed'; value: T }
  | {
      kind: 'reconciliation_required';
      sourceStatus: 401 | 503;
      error: BoardErrorV1;
      acquisitionGeneration: string;
      retryAfterMs: number | null;
    }
  | {
      kind: 'http_error';
      sourceStatus: 400 | 403 | 404 | 429 | 500;
      error: BoardErrorV1;
      retryAfterMs: number | null;
    }
  | {
      kind: 'protocol_error';
      sourceStatus: number | null;
      error: BoardErrorV1 | null;
    };

export type BoardStreamDispatchPortV1 = {
  open<T>(
    input: BoardStreamOpenInputV1,
    consumeOkResponse: (response: Response, heldSignal: AbortSignal) => Promise<T>,
  ): Promise<BoardStreamDispatchResultV1<T>>;
};

export type BoardStreamCallbacksV1 = {
  replaceSnapshot(
    snapshot: import('@sceneboard/board-schema').BoardSnapshotV1,
  ): void | Promise<void>;
  refreshRevisionSnapshot(
    event: BoardRevisionHintEnvelopeV1,
  ): Promise<BoardRevisionSnapshotAdmissionV1>;
  applyDurableEvent(event: BoardIncrementalDurableEnvelopeV1): void | Promise<void>;
  replacePresence(
    presence: readonly import('@sceneboard/board-schema').PresenceSummaryV1[],
  ): void | Promise<void>;
  onState(state: BoardStreamStateV1): void | Promise<void>;
};

export type BoardStreamFailureV1 =
  | {
      kind: 'reconciliation_required';
      sourceStatus: 401 | 503;
      error: BoardErrorV1;
      acquisitionGeneration: string;
      retryAfterMs: number | null;
    }
  | { kind: 'forbidden'; sourceStatus: 403; error: BoardErrorV1 }
  | { kind: 'not_found'; sourceStatus: 404; error: BoardErrorV1 }
  | { kind: 'invalid_request'; sourceStatus: 400; error: BoardErrorV1 }
  | { kind: 'rate_limited'; sourceStatus: 429; error: BoardErrorV1; retryAfterMs: number }
  | { kind: 'internal_error'; sourceStatus: 500; error: BoardErrorV1 }
  | { kind: 'server_error'; error: BoardErrorV1; retryable: boolean; retryAfterMs: number | null }
  | {
      kind: 'consumer_callback';
      callback: 'snapshot' | 'revision_snapshot' | 'durable_event' | 'presence' | 'state';
    }
  | { kind: 'protocol'; sourceStatus: number | null; error: BoardErrorV1 | null }
  | { kind: 'transport'; retryable: true; reason: 'network' | 'heartbeat_timeout' | 'offline' };

export type BoardStreamStateV1 =
  | { state: 'idle' }
  | { state: 'connecting'; attempt: number }
  | { state: 'live'; lastAppliedSequence: number }
  | {
      state: 'reconnecting';
      reason:
        | 'planned_recycle'
        | 'revision_rebase'
        | 'network'
        | 'heartbeat_timeout'
        | 'offline'
        | 'rate_limited'
        | 'invalid_cursor_reset'
        | 'server_resync'
        | 'server_retryable';
      retryAfterMs: number;
    }
  | {
      state: 'reconciliation_required';
      failure: Extract<BoardStreamFailureV1, { kind: 'reconciliation_required' }>;
    }
  | {
      state: 'terminal';
      failure: Extract<
        BoardStreamFailureV1,
        {
          kind:
            | 'forbidden'
            | 'not_found'
            | 'invalid_request'
            | 'internal_error'
            | 'server_error'
            | 'consumer_callback'
            | 'protocol';
        }
      >;
    };

export type BoardStreamClientOptionsV1 = {
  apiOrigin: string;
  boardId: BoardId;
  tabId: string;
  initialPresenceState: BoardStreamPresenceStateV1;
  minimumSnapshotSequence: number;
  dispatch: BoardStreamDispatchPortV1;
  callbacks: BoardStreamCallbacksV1;
  routeSignal: AbortSignal;
};

export type BoardStreamRunResultV1 =
  | { kind: 'stopped'; reason: 'consumer_stop' | 'route_abort' | 'context_loss' }
  | { kind: 'terminal'; failure: BoardStreamFailureV1 };

export type BoardStreamClientV1 = {
  start(): Promise<BoardStreamRunResultV1>;
  setPresenceState(state: BoardStreamPresenceStateV1): void;
  stop(reason?: 'consumer_stop' | 'route_abort' | 'context_loss'): Promise<BoardStreamRunResultV1>;
};
