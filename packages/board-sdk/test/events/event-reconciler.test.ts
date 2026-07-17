import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BoardEventEnvelopeParserV1,
  canonicalizeJsonV1,
  type BoardEventEnvelopeV1,
  type BoardId,
} from '@leecat-board/board-schema';

import { createBoardEventReconcilerV1 } from '../../src/events/index.js';

const BOARD_ID = 'board_1' as BoardId;
const fixtureRoot = new URL('../../../board-schema/test/fixtures/valid/', import.meta.url);

const readEvent = (name: string): BoardEventEnvelopeV1 => {
  const parsed = BoardEventEnvelopeParserV1.parse(
    JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid event fixture');
  return parsed.data.value;
};

const withSequence = (
  event: BoardEventEnvelopeV1,
  sequence: number,
  eventId = `event_${sequence}`,
): BoardEventEnvelopeV1 => {
  const value = structuredClone(event);
  value.sequence = sequence;
  value.eventId = eventId as BoardEventEnvelopeV1['eventId'];
  if (value.data.type === 'board.snapshot') value.data.snapshot.lastEventSequence = sequence;
  if (value.data.type === 'stream.resync.required') value.data.lastUsableSequence = sequence - 1;
  return value;
};

const inputFor = (envelope: BoardEventEnvelopeV1, cursor: string | null) => {
  const canonical = canonicalizeJsonV1(envelope);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new Error('event fixture canonicalization failed');
  return { envelope, canonicalBytes: canonical.data.canonicalBytes, cursor };
};

test('gates snapshot, durable, and presence cursor advancement on matching commits', () => {
  const snapshot = withSequence(readEvent('event-board-snapshot.v1.json'), 1);
  const durable = withSequence(readEvent('event-artifact-status-changed.v1.json'), 2);
  const presence = withSequence(readEvent('event-presence-updated.v1.json'), 2, 'event_presence');
  const reconciler = createBoardEventReconcilerV1({ boardId: BOARD_ID, minimumSnapshotSequence: 1 });

  const pendingSnapshot = reconciler.evaluate(inputFor(snapshot, 'cursor_1'));
  assert.equal(pendingSnapshot.kind, 'pending_effect');
  if (pendingSnapshot.kind !== 'pending_effect') return;
  assert.equal(pendingSnapshot.effect.kind, 'replace_snapshot');
  assert.deepEqual(
    reconciler.evaluate(inputFor(durable, 'cursor_2')),
    { kind: 'protocol_failure', reason: 'control_sequence', clearCursor: false },
  );
  assert.throws(() => reconciler.commit(999, { kind: 'effect_applied' }), TypeError);
  assert.deepEqual(
    reconciler.commit(pendingSnapshot.acceptanceId, { kind: 'effect_applied' }),
    { kind: 'continue', lastAppliedSequence: 1, cursor: 'cursor_1' },
  );

  const pendingDurable = reconciler.evaluate(inputFor(durable, 'cursor_2'));
  assert.equal(pendingDurable.kind, 'pending_effect');
  if (pendingDurable.kind !== 'pending_effect') return;
  assert.equal(pendingDurable.effect.kind, 'apply_durable_event');
  assert.deepEqual(
    reconciler.commit(pendingDurable.acceptanceId, { kind: 'effect_applied' }),
    { kind: 'continue', lastAppliedSequence: 2, cursor: 'cursor_2' },
  );

  const pendingPresence = reconciler.evaluate(inputFor(presence, null));
  assert.equal(pendingPresence.kind, 'pending_effect');
  if (pendingPresence.kind !== 'pending_effect') return;
  assert.equal(pendingPresence.effect.kind, 'replace_presence');
  assert.deepEqual(
    reconciler.commit(pendingPresence.acceptanceId, { kind: 'effect_applied' }),
    { kind: 'continue', lastAppliedSequence: 2, cursor: 'cursor_2' },
  );
});

test('retains exact duplicates and clears unsafe ordering outcomes', () => {
  const snapshot = withSequence(readEvent('event-board-snapshot.v1.json'), 9, 'event_9');
  const durable = withSequence(readEvent('event-hitl-updated.v1.json'), 10, 'event_10');
  const reconciler = createBoardEventReconcilerV1({ boardId: BOARD_ID, minimumSnapshotSequence: 9 });
  const pendingSnapshot = reconciler.evaluate(inputFor(snapshot, 'cursor_9'));
  assert.equal(pendingSnapshot.kind, 'pending_effect');
  if (pendingSnapshot.kind !== 'pending_effect') return;
  reconciler.commit(pendingSnapshot.acceptanceId, { kind: 'effect_applied' });
  const pendingDurable = reconciler.evaluate(inputFor(durable, 'cursor_10'));
  assert.equal(pendingDurable.kind, 'pending_effect');
  if (pendingDurable.kind !== 'pending_effect') return;
  reconciler.commit(pendingDurable.acceptanceId, { kind: 'effect_applied' });

  assert.deepEqual(
    reconciler.evaluate(inputFor(durable, 'cursor_replayed')),
    { kind: 'duplicate', sequence: 10, retainedCursor: 'cursor_10' },
  );
  const conflicting = withSequence(durable, 10, 'event_conflict');
  assert.deepEqual(
    reconciler.evaluate(inputFor(conflicting, 'cursor_10')),
    { kind: 'resync_required', reason: 'conflicting_duplicate', clearCursor: true },
  );
  const gap = withSequence(readEvent('event-hitl-updated.v1.json'), 12);
  assert.deepEqual(
    reconciler.evaluate(inputFor(gap, 'cursor_12')),
    { kind: 'resync_required', reason: 'sequence_gap', clearCursor: true },
  );
  const stale = withSequence(readEvent('event-hitl-updated.v1.json'), 8);
  assert.deepEqual(
    reconciler.evaluate(inputFor(stale, 'cursor_9')),
    { kind: 'resync_required', reason: 'stale_duplicate_unverifiable', clearCursor: true },
  );
});

test('rebases revision hints through an authoritative HTTP snapshot admission', () => {
  const snapshot = withSequence(readEvent('event-board-snapshot.v1.json'), 1);
  const revision = withSequence(readEvent('event-revision-created.v1.json'), 2);
  const reconciler = createBoardEventReconcilerV1({ boardId: BOARD_ID, minimumSnapshotSequence: 1 });
  const initial = reconciler.evaluate(inputFor(snapshot, 'cursor_1'));
  assert.equal(initial.kind, 'pending_effect');
  if (initial.kind !== 'pending_effect') return;
  reconciler.commit(initial.acceptanceId, { kind: 'effect_applied' });

  const hint = reconciler.evaluate(inputFor(revision, 'cursor_2'));
  assert.equal(hint.kind, 'pending_effect');
  if (hint.kind !== 'pending_effect') return;
  assert.equal(hint.effect.kind, 'refresh_revision_snapshot');
  assert.throws(
    () => reconciler.commit(hint.acceptanceId, {
      kind: 'authoritative_revision_snapshot',
      lastEventSequence: 1,
    }),
    TypeError,
  );
  assert.deepEqual(
    reconciler.commit(hint.acceptanceId, {
      kind: 'authoritative_revision_snapshot',
      lastEventSequence: 4,
    }),
    { kind: 'restart_without_cursor', minimumSnapshotSequence: 4, cursor: null },
  );
  const below = withSequence(snapshot, 3, 'event_3');
  assert.deepEqual(
    reconciler.evaluate(inputFor(below, 'cursor_3')),
    { kind: 'protocol_failure', reason: 'snapshot_below_minimum', clearCursor: false },
  );
});

test('separates heartbeat, server resync, stream error, and rejection outcomes', () => {
  const snapshot = withSequence(readEvent('event-board-snapshot.v1.json'), 1);
  const heartbeat = withSequence(readEvent('event-stream-heartbeat.v1.json'), 1, 'event_heartbeat');
  const error = withSequence(readEvent('event-stream-error.v1.json'), 1, 'event_error');
  const resync = withSequence(readEvent('event-stream-resync-required.v1.json'), 2, 'event_resync');
  const presence = withSequence(readEvent('event-presence-updated.v1.json'), 1, 'event_presence');
  const reconciler = createBoardEventReconcilerV1({ boardId: BOARD_ID, minimumSnapshotSequence: 1 });
  const initial = reconciler.evaluate(inputFor(snapshot, 'cursor_1'));
  assert.equal(initial.kind, 'pending_effect');
  if (initial.kind !== 'pending_effect') return;
  reconciler.commit(initial.acceptanceId, { kind: 'effect_applied' });

  assert.deepEqual(reconciler.evaluate(inputFor(heartbeat, null)), { kind: 'heartbeat' });
  assert.deepEqual(
    reconciler.evaluate(inputFor(error, null)),
    {
      kind: 'stream_error',
      error: error.data.type === 'stream.error' ? error.data.error : null,
      action: 'terminal',
      retainCursor: true,
      retryAfterMs: null,
    },
  );
  assert.deepEqual(
    reconciler.evaluate(inputFor(resync, null)),
    { kind: 'resync_required', reason: 'gap', clearCursor: true },
  );

  const pendingPresence = reconciler.evaluate(inputFor(presence, null));
  assert.equal(pendingPresence.kind, 'pending_effect');
  if (pendingPresence.kind !== 'pending_effect') return;
  reconciler.reject(pendingPresence.acceptanceId);
  assert.deepEqual(reconciler.evaluate(inputFor(heartbeat, null)), { kind: 'heartbeat' });
});
