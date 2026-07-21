import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_ERROR_CODES_V1,
  BOARD_EVENT_TYPES_V1,
  BoardErrorParserV1,
  BoardEventEnvelopeParserV1,
  BoardSnapshotParserV1,
} from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

test('accepts all event and error catalog branches', async () => {
  assert.equal(BOARD_EVENT_TYPES_V1.length, 8);
  assert.equal(BOARD_ERROR_CODES_V1.length, 25);
  for (const path of [
    'event-board-snapshot',
    'event-revision-created',
    'event-hitl-updated',
    'event-artifact-status-changed',
    'event-presence-updated',
    'event-stream-resync-required',
    'event-stream-heartbeat',
    'event-stream-error',
  ]) {
    assert.equal(
      BoardEventEnvelopeParserV1.parse(await loadFixture(`valid/${path}.v1.json`)).ok,
      true,
      path,
    );
  }
  for (const path of [
    'error-invalid-payload',
    'error-revision-conflict',
    'error-idempotency-key-reused',
    'error-hitl-request-id-conflict',
    'error-hitl-response-conflict',
    'error-hitl-request-expired',
  ]) {
    assert.equal(
      BoardErrorParserV1.parse(await loadFixture(`valid/${path}.v1.json`)).ok,
      true,
      path,
    );
  }
});

test('enforces the inclusive snapshot event cut', async () => {
  assert.equal(
    BoardEventEnvelopeParserV1.parse(
      await loadFixture('invalid/event-snapshot-board-id-mismatch.v1.json'),
    ).ok,
    false,
  );
  assert.equal(
    BoardEventEnvelopeParserV1.parse(
      await loadFixture('invalid/event-snapshot-sequence-mismatch.v1.json'),
    ).ok,
    false,
  );
});

test('resolves placed HITL, artifact, and image references exactly', async () => {
  assert.equal(
    BoardSnapshotParserV1.parse(
      await loadFixture('invalid/snapshot-unresolved-hitl-reference.v1.json'),
    ).ok,
    false,
  );
  assert.equal(
    BoardSnapshotParserV1.parse(
      await loadFixture('invalid/snapshot-unresolved-artifact-reference.v1.json'),
    ).ok,
    false,
  );
  assert.equal(
    BoardSnapshotParserV1.parse(
      await loadFixture('invalid/snapshot-unresolved-image-artifact-reference.v1.json'),
    ).ok,
    false,
  );
});

test('allows unplaced runtime summaries but rejects duplicate stable identities', async () => {
  const snapshot = (await loadFixture('valid/snapshot-board.v1.json')) as Record<string, unknown>;
  const hitlEvent = (await loadFixture('valid/event-hitl-updated.v1.json')) as Record<
    string,
    unknown
  >;
  const artifactEvent = (await loadFixture(
    'valid/event-artifact-status-changed.v1.json',
  )) as Record<string, unknown>;
  const hitl = (hitlEvent.data as Record<string, unknown>).hitl;
  const artifact = (artifactEvent.data as Record<string, unknown>).artifact;
  assert.equal(
    BoardSnapshotParserV1.parse({ ...snapshot, hitl: [hitl], artifacts: [artifact] }).ok,
    true,
  );
  assert.equal(BoardSnapshotParserV1.parse({ ...snapshot, hitl: [hitl, hitl] }).ok, false);
  assert.equal(
    BoardSnapshotParserV1.parse({ ...snapshot, artifacts: [artifact, artifact] }).ok,
    false,
  );
});

test('enforces revision, control-event, resync, heartbeat, and presence relations', async () => {
  const revision = (await loadFixture('valid/event-revision-created.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    BoardEventEnvelopeParserV1.parse({ ...revision, revisionId: 'revision_other' }).ok,
    false,
  );

  const hitl = (await loadFixture('valid/event-hitl-updated.v1.json')) as Record<string, unknown>;
  assert.equal(BoardEventEnvelopeParserV1.parse({ ...hitl, revisionId: 'revision_1' }).ok, false);

  const resync = (await loadFixture('valid/event-stream-resync-required.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    BoardEventEnvelopeParserV1.parse({
      ...resync,
      data: { ...(resync.data as object), lastUsableSequence: resync.sequence },
    }).ok,
    false,
  );

  const heartbeat = (await loadFixture('valid/event-stream-heartbeat.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    BoardEventEnvelopeParserV1.parse({
      ...heartbeat,
      data: { ...(heartbeat.data as object), sentAt: '2026-07-16T00:00:01.000Z' },
    }).ok,
    false,
  );

  const presence = (await loadFixture('valid/event-presence-updated.v1.json')) as Record<
    string,
    unknown
  >;
  const entries = (presence.data as Record<string, unknown>).presence as unknown[];
  assert.equal(
    BoardEventEnvelopeParserV1.parse({
      ...presence,
      data: { ...(presence.data as object), presence: [...entries, ...entries] },
    }).ok,
    false,
  );
});

test('parses all twenty-five exact error branches and rejects cross-branch metadata', async () => {
  const errorEntries = [
    'invalid-payload',
    'protocol-version-mismatch',
    'unknown-node-type',
    'unknown-command-type',
    'unknown-operation-type',
    'invalid-layout',
    'duplicate-node-id',
    'limit-exceeded',
    'payload-too-large',
    'unauthenticated',
    'forbidden',
    'capability-denied',
    'board-not-found',
    'revision-not-found',
    'artifact-not-found',
    'hitl-request-not-found',
    'board-already-archived',
    'revision-conflict',
    'idempotency-key-reused',
    'hitl-request-id-conflict',
    'hitl-response-conflict',
    'hitl-request-expired',
    'rate-limited',
    'service-unavailable',
    'internal',
  ];
  assert.equal(errorEntries.length, 25);
  for (const name of errorEntries)
    assert.equal(
      BoardErrorParserV1.parse(await loadFixture(`valid/error-${name}.v1.json`)).ok,
      true,
      name,
    );
  assert.equal(
    BoardErrorParserV1.parse(await loadFixture('invalid/error-details-code-mismatch.v1.json')).ok,
    false,
  );
});
