import type {
  BoardErrorV1,
  BoardEventEnvelopeV1,
  BoardId,
  BoardSnapshotV1,
  PresenceSummaryV1,
} from '@leecat-board/board-schema';

export type BoardEventReconcileInputV1 = {
  envelope: BoardEventEnvelopeV1;
  canonicalBytes: Uint8Array;
  cursor: string | null;
};

export type BoardRevisionHintEnvelopeV1 = BoardEventEnvelopeV1 & {
  data: Extract<BoardEventEnvelopeV1['data'], { type: 'board.revision.created' }>;
};

export type BoardIncrementalDurableEnvelopeV1 = BoardEventEnvelopeV1 & {
  data: Extract<BoardEventEnvelopeV1['data'], { type: 'hitl.updated' | 'artifact.status.changed' }>;
};

export type BoardRevisionSnapshotAdmissionV1 = {
  kind: 'authoritative_revision_snapshot';
  lastEventSequence: number;
};

export type BoardEventCommitOutcomeV1 =
  | { kind: 'effect_applied' }
  | BoardRevisionSnapshotAdmissionV1;

export type BoardEventCommitResultV1 =
  | { kind: 'continue'; lastAppliedSequence: number; cursor: string | null }
  | { kind: 'restart_without_cursor'; minimumSnapshotSequence: number; cursor: null };

export type BoardEventReconcileResultV1 =
  | {
      kind: 'pending_effect';
      acceptanceId: number;
      effect:
        | { kind: 'replace_snapshot'; snapshot: BoardSnapshotV1 }
        | { kind: 'refresh_revision_snapshot'; event: BoardRevisionHintEnvelopeV1 }
        | { kind: 'apply_durable_event'; event: BoardIncrementalDurableEnvelopeV1 }
        | { kind: 'replace_presence'; presence: readonly PresenceSummaryV1[] };
    }
  | { kind: 'duplicate'; sequence: number; retainedCursor: string }
  | { kind: 'heartbeat' }
  | {
      kind: 'resync_required';
      reason:
        | 'sequence_gap'
        | 'conflicting_duplicate'
        | 'stale_duplicate_unverifiable'
        | 'gap'
        | 'expired_cursor'
        | 'server_reset';
      clearCursor: true;
    }
  | {
      kind: 'stream_error';
      error: BoardErrorV1;
      action: 'reconnect' | 'terminal';
      retainCursor: true;
      retryAfterMs: number | null;
    }
  | {
      kind: 'protocol_failure';
      reason:
        | 'wrong_board'
        | 'unexpected_snapshot'
        | 'snapshot_below_minimum'
        | 'cursor_cardinality'
        | 'control_sequence';
      clearCursor: false;
    };

export type BoardEventReconcilerV1 = {
  evaluate(input: BoardEventReconcileInputV1): BoardEventReconcileResultV1;
  commit(acceptanceId: number, outcome: BoardEventCommitOutcomeV1): BoardEventCommitResultV1;
  reject(acceptanceId: number): void;
  prepareForNoCursorSnapshot(minimumSnapshotSequence: number): void;
};

type DurableEnvelope =
  | BoardRevisionHintEnvelopeV1
  | BoardIncrementalDurableEnvelopeV1
  | (BoardEventEnvelopeV1 & {
      data: Extract<BoardEventEnvelopeV1['data'], { type: 'board.snapshot' }>;
    });

type PendingEffect = {
  acceptanceId: number;
  envelope: BoardEventEnvelopeV1;
  canonicalBytes: Uint8Array;
  cursor: string | null;
  effectKind: 'snapshot' | 'revision' | 'durable' | 'presence';
};

type DurableIdentity = {
  eventId: string;
  canonicalBytes: Uint8Array;
  cursor: string;
};

const MAX_LEDGER_ENTRIES = 1_001;

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const retryAfterMs = (error: BoardErrorV1): number | null => {
  const seconds = error.code === 'RATE_LIMITED'
    ? error.details.retryAfterSeconds
    : error.code === 'SERVICE_UNAVAILABLE'
      ? error.details.retryAfterSeconds
      : null;
  if (seconds === null) return null;
  return Math.round(Math.min(60, Math.max(1, seconds)) * 1_000);
};

const isDurable = (envelope: BoardEventEnvelopeV1): envelope is DurableEnvelope => (
  envelope.data.type === 'board.snapshot'
  || envelope.data.type === 'board.revision.created'
  || envelope.data.type === 'hitl.updated'
  || envelope.data.type === 'artifact.status.changed'
);

const assertSafeWatermark = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('minimumSnapshotSequence must be a non-negative safe integer');
  }
};

export const createBoardEventReconcilerV1 = (input: {
  boardId: BoardId;
  minimumSnapshotSequence: number;
}): BoardEventReconcilerV1 => {
  assertSafeWatermark(input.minimumSnapshotSequence);

  let minimumSnapshotSequence = input.minimumSnapshotSequence;
  let awaitingSnapshot = true;
  let lastAppliedSequence = 0;
  let retainedCursor: string | null = null;
  let nextAcceptanceId = 1;
  let pending: PendingEffect | null = null;
  const ledger = new Map<number, DurableIdentity>();

  const protocolFailure = (
    reason: Extract<BoardEventReconcileResultV1, { kind: 'protocol_failure' }>['reason'],
  ): BoardEventReconcileResultV1 => ({ kind: 'protocol_failure', reason, clearCursor: false });

  const remember = (effect: PendingEffect): void => {
    if (effect.cursor === null) throw new TypeError('durable effect requires a cursor');
    ledger.set(effect.envelope.sequence, {
      eventId: effect.envelope.eventId,
      canonicalBytes: effect.canonicalBytes.slice(),
      cursor: effect.cursor,
    });
    while (ledger.size > MAX_LEDGER_ENTRIES) {
      const oldest = ledger.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      ledger.delete(oldest);
    }
  };

  const stage = (
    inputValue: BoardEventReconcileInputV1,
    effectKind: PendingEffect['effectKind'],
    effect: Extract<BoardEventReconcileResultV1, { kind: 'pending_effect' }>['effect'],
  ): BoardEventReconcileResultV1 => {
    if (nextAcceptanceId > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('event acceptance ID space exhausted');
    }
    const acceptanceId = nextAcceptanceId;
    nextAcceptanceId += 1;
    pending = {
      acceptanceId,
      envelope: inputValue.envelope,
      canonicalBytes: inputValue.canonicalBytes.slice(),
      cursor: inputValue.cursor,
      effectKind,
    };
    return { kind: 'pending_effect', acceptanceId, effect };
  };

  const evaluate = (inputValue: BoardEventReconcileInputV1): BoardEventReconcileResultV1 => {
    if (pending !== null) return protocolFailure('control_sequence');
    const { envelope, cursor } = inputValue;
    if (envelope.boardId !== input.boardId) return protocolFailure('wrong_board');

    const durable = isDurable(envelope);
    if ((durable && cursor === null) || (!durable && cursor !== null)) {
      return protocolFailure('cursor_cardinality');
    }

    if (envelope.data.type === 'board.snapshot') {
      if (!awaitingSnapshot) return protocolFailure('unexpected_snapshot');
      if (envelope.sequence < minimumSnapshotSequence) return protocolFailure('snapshot_below_minimum');
      return stage(inputValue, 'snapshot', {
        kind: 'replace_snapshot',
        snapshot: envelope.data.snapshot,
      });
    }

    if (envelope.data.type === 'presence.updated') {
      if (awaitingSnapshot || envelope.sequence !== lastAppliedSequence) {
        return protocolFailure('control_sequence');
      }
      return stage(inputValue, 'presence', {
        kind: 'replace_presence',
        presence: envelope.data.presence,
      });
    }

    if (envelope.data.type === 'stream.heartbeat') {
      return !awaitingSnapshot && envelope.sequence === lastAppliedSequence
        ? { kind: 'heartbeat' }
        : protocolFailure('control_sequence');
    }

    if (envelope.data.type === 'stream.resync.required') {
      if (awaitingSnapshot
        || envelope.data.lastUsableSequence !== lastAppliedSequence
        || envelope.sequence !== lastAppliedSequence + 1) {
        return protocolFailure('control_sequence');
      }
      return {
        kind: 'resync_required',
        reason: envelope.data.reason,
        clearCursor: true,
      };
    }

    if (envelope.data.type === 'stream.error') {
      if (awaitingSnapshot || envelope.sequence !== lastAppliedSequence) {
        return protocolFailure('control_sequence');
      }
      return {
        kind: 'stream_error',
        error: envelope.data.error,
        action: envelope.data.error.retryable ? 'reconnect' : 'terminal',
        retainCursor: true,
        retryAfterMs: retryAfterMs(envelope.data.error),
      };
    }

    if (awaitingSnapshot) return protocolFailure('control_sequence');
    const acceptedIdentity = ledger.get(envelope.sequence);
    if (envelope.sequence <= lastAppliedSequence) {
      if (acceptedIdentity === undefined) {
        return {
          kind: 'resync_required',
          reason: 'stale_duplicate_unverifiable',
          clearCursor: true,
        };
      }
      if (acceptedIdentity.eventId !== envelope.eventId
        || !equalBytes(acceptedIdentity.canonicalBytes, inputValue.canonicalBytes)) {
        return {
          kind: 'resync_required',
          reason: 'conflicting_duplicate',
          clearCursor: true,
        };
      }
      return {
        kind: 'duplicate',
        sequence: envelope.sequence,
        retainedCursor: acceptedIdentity.cursor,
      };
    }
    if (envelope.sequence !== lastAppliedSequence + 1) {
      return { kind: 'resync_required', reason: 'sequence_gap', clearCursor: true };
    }
    if (envelope.data.type === 'board.revision.created') {
      return stage(inputValue, 'revision', {
        kind: 'refresh_revision_snapshot',
        event: envelope as BoardRevisionHintEnvelopeV1,
      });
    }
    return stage(inputValue, 'durable', {
      kind: 'apply_durable_event',
      event: envelope as BoardIncrementalDurableEnvelopeV1,
    });
  };

  const commit = (
    acceptanceId: number,
    outcome: BoardEventCommitOutcomeV1,
  ): BoardEventCommitResultV1 => {
    if (pending === null || pending.acceptanceId !== acceptanceId) {
      throw new TypeError('acceptanceId does not identify the pending effect');
    }
    const effect = pending;
    if (effect.effectKind === 'revision') {
      if (outcome.kind !== 'authoritative_revision_snapshot'
        || !Number.isSafeInteger(outcome.lastEventSequence)
        || outcome.lastEventSequence < effect.envelope.sequence) {
        throw new TypeError('revision effect requires an authoritative snapshot at or above the hint sequence');
      }
      pending = null;
      lastAppliedSequence = outcome.lastEventSequence;
      minimumSnapshotSequence = outcome.lastEventSequence;
      retainedCursor = null;
      awaitingSnapshot = true;
      ledger.clear();
      return {
        kind: 'restart_without_cursor',
        minimumSnapshotSequence,
        cursor: null,
      };
    }
    if (outcome.kind !== 'effect_applied') {
      throw new TypeError('effect outcome does not match the pending effect');
    }
    pending = null;
    if (effect.effectKind === 'presence') {
      return { kind: 'continue', lastAppliedSequence, cursor: retainedCursor };
    }
    if (effect.cursor === null) throw new TypeError('durable effect requires a cursor');
    lastAppliedSequence = effect.envelope.sequence;
    retainedCursor = effect.cursor;
    awaitingSnapshot = false;
    minimumSnapshotSequence = lastAppliedSequence;
    remember(effect);
    return { kind: 'continue', lastAppliedSequence, cursor: retainedCursor };
  };

  const reject = (acceptanceId: number): void => {
    if (pending === null || pending.acceptanceId !== acceptanceId) {
      throw new TypeError('acceptanceId does not identify the pending effect');
    }
    pending = null;
  };

  const prepareForNoCursorSnapshot = (minimum: number): void => {
    assertSafeWatermark(minimum);
    if (pending !== null) throw new TypeError('cannot reset while an effect is pending');
    minimumSnapshotSequence = minimum;
    lastAppliedSequence = minimum;
    retainedCursor = null;
    awaitingSnapshot = true;
    ledger.clear();
  };

  return { evaluate, commit, reject, prepareForNoCursorSnapshot };
};
