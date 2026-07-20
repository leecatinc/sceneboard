import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardEventEnvelopeParserV1,
  BoardSnapshotParserV1,
  type BoardSnapshotV1,
  type RevisionId,
} from '@leecat-board/board-schema';

import { RequestEpochV1 } from '../../src/client/index.js';
import {
  applyDurableEventV1,
  createLiveBoardStateV1,
  enterHistoryV1,
  hasLiveUpdateV1,
  replaceLiveSnapshotV1,
  visibleBoardSnapshotV1,
} from '../../src/state/index.js';

const parsed = BoardSnapshotParserV1.parse(JSON.parse(readFileSync(new URL('../../../board-schema/test/fixtures/valid/snapshot-board.v1.json', import.meta.url), 'utf8')));
if (!parsed.ok) throw new TypeError('snapshot fixture is invalid');
const first = parsed.data.value;

const artifactEventParsed = BoardEventEnvelopeParserV1.parse(JSON.parse(readFileSync(new URL('../../../board-schema/test/fixtures/valid/event-artifact-status-changed.v1.json', import.meta.url), 'utf8')));
if (!artifactEventParsed.ok) throw new TypeError('artifact event fixture is invalid');
const parsedArtifactEvent = artifactEventParsed.data.value;
if (parsedArtifactEvent.data.type !== 'artifact.status.changed') throw new TypeError('artifact event fixture is invalid');
const artifactEvent = { ...parsedArtifactEvent, data: parsedArtifactEvent.data };

const hitlEventParsed = BoardEventEnvelopeParserV1.parse(JSON.parse(readFileSync(new URL('../../../board-schema/test/fixtures/valid/event-hitl-updated.v1.json', import.meta.url), 'utf8')));
if (!hitlEventParsed.ok || hitlEventParsed.data.value.data.type !== 'hitl.updated') throw new TypeError('HITL event fixture is invalid');
const hitlEvent = { ...hitlEventParsed.data.value, data: hitlEventParsed.data.value.data };
const answeredHitlParsed = BoardEventEnvelopeParserV1.parse({
  ...hitlEvent,
  eventId: 'event_2',
  sequence: 2,
  occurredAt: '2026-07-16T00:01:00.000Z',
  data: {
    type: 'hitl.updated',
    hitl: {
      ...hitlEvent.data.hitl,
      state: 'answered',
      stateUpdatedAt: '2026-07-16T00:01:00.000Z',
      response: { kind: 'info', acknowledged: true },
      answeredAt: '2026-07-16T00:01:00.000Z',
    },
  },
});
if (!answeredHitlParsed.ok || answeredHitlParsed.data.value.data.type !== 'hitl.updated') throw new TypeError('answered HITL event fixture is invalid');
const answeredHitlEvent = { ...answeredHitlParsed.data.value, data: answeredHitlParsed.data.value.data };

const secondHitlParsed = BoardEventEnvelopeParserV1.parse({
  ...hitlEvent,
  eventId: 'event_3',
  sequence: 3,
  occurredAt: '2026-07-16T00:02:00.000Z',
  data: {
    type: 'hitl.updated',
    hitl: {
      ...hitlEvent.data.hitl,
      hitlRequestId: 'hitl_2',
      createdAt: '2026-07-16T00:02:00.000Z',
      expiresAt: '2026-07-16T00:04:00.000Z',
      stateUpdatedAt: '2026-07-16T00:02:00.000Z',
    },
  },
});
if (!secondHitlParsed.ok || secondHitlParsed.data.value.data.type !== 'hitl.updated') throw new TypeError('second HITL event fixture is invalid');
const secondHitlEvent = { ...secondHitlParsed.data.value, data: secondHitlParsed.data.value.data };

const answeredSecondHitlParsed = BoardEventEnvelopeParserV1.parse({
  ...secondHitlEvent,
  eventId: 'event_4',
  sequence: 4,
  occurredAt: '2026-07-16T00:03:00.000Z',
  data: {
    type: 'hitl.updated',
    hitl: {
      ...secondHitlEvent.data.hitl,
      state: 'answered',
      stateUpdatedAt: '2026-07-16T00:03:00.000Z',
      response: { kind: 'info', acknowledged: true },
      answeredAt: '2026-07-16T00:03:00.000Z',
    },
  },
});
if (!answeredSecondHitlParsed.ok || answeredSecondHitlParsed.data.value.data.type !== 'hitl.updated') throw new TypeError('answered second HITL event fixture is invalid');
const answeredSecondHitlEvent = { ...answeredSecondHitlParsed.data.value, data: answeredSecondHitlParsed.data.value.data };

const wrongBoardHitlParsed = BoardEventEnvelopeParserV1.parse({
  ...secondHitlEvent,
  boardId: 'board_2',
  eventId: 'event_5',
  sequence: 5,
});
if (!wrongBoardHitlParsed.ok || wrongBoardHitlParsed.data.value.data.type !== 'hitl.updated') throw new TypeError('wrong-board HITL event fixture is invalid');
const wrongBoardHitlEvent = { ...wrongBoardHitlParsed.data.value, data: wrongBoardHitlParsed.data.value.data };

const revision = (source: BoardSnapshotV1, id: string, number: number): BoardSnapshotV1 => ({
  ...source,
  revision: {
    ...source.revision,
    revisionId: id as RevisionId,
    revisionNumber: number,
    previousRevisionId: source.revision.revisionId,
    originType: 'scene.replace',
  },
});

test('historical view stays immutable while the hidden live head advances', () => {
  const second = revision(first, 'revision_2', 2);
  const third = revision(second, 'revision_3', 3);
  let state = createLiveBoardStateV1(second);
  state = enterHistoryV1(state, first, {
    revisionId: first.revision.revisionId,
    previousRevisionId: null,
    nextRevisionId: second.revision.revisionId,
    latestRevisionId: second.revision.revisionId,
    label: 'Initial',
  });
  const visible = visibleBoardSnapshotV1(state);
  state = replaceLiveSnapshotV1(state, third);
  assert.equal(visibleBoardSnapshotV1(state), visible);
  assert.equal(hasLiveUpdateV1(state), true);
});

test('request epoch rejects late work after navigation and close', () => {
  const epoch = new RequestEpochV1();
  const initial = epoch.capture();
  assert.equal(epoch.isCurrent(initial), true);
  epoch.advance();
  assert.equal(epoch.isCurrent(initial), false);
  const latest = epoch.capture();
  epoch.close();
  assert.equal(epoch.isCurrent(latest), false);
});

test('artifact status arriving before scene placement is admitted into live state', () => {
  const state = applyDurableEventV1(createLiveBoardStateV1(first), artifactEvent);

  assert.deepEqual(state.liveSnapshot.artifacts, [artifactEvent.data.artifact]);
});

test('new durable HITL is appended to hidden live state without mutating history', () => {
  const second = revision(first, 'revision_2', 2);
  let state = createLiveBoardStateV1(second);
  state = enterHistoryV1(state, first, {
    revisionId: first.revision.revisionId,
    previousRevisionId: null,
    nextRevisionId: second.revision.revisionId,
    latestRevisionId: second.revision.revisionId,
    label: 'Initial',
  });
  const visible = visibleBoardSnapshotV1(state);

  state = applyDurableEventV1(state, hitlEvent);

  assert.equal(visibleBoardSnapshotV1(state), visible);
  assert.deepEqual(state.liveSnapshot.hitl, [hitlEvent.data.hitl]);
});

test('later durable HITL state replaces the stable request without duplication', () => {
  let state = applyDurableEventV1(createLiveBoardStateV1(first), hitlEvent);

  state = applyDurableEventV1(state, answeredHitlEvent);

  assert.equal(state.liveSnapshot.hitl.length, 1);
  assert.deepEqual(state.liveSnapshot.hitl[0], answeredHitlEvent.data.hitl);
});

test('durable HITL appends and updates only the exact identity in a populated historical state', () => {
  const second = revision(first, 'revision_2', 2);
  const liveWithFirst = { ...second, hitl: [hitlEvent.data.hitl] };
  let state = enterHistoryV1(createLiveBoardStateV1(liveWithFirst), first, {
    revisionId: first.revision.revisionId,
    previousRevisionId: null,
    nextRevisionId: second.revision.revisionId,
    latestRevisionId: second.revision.revisionId,
    label: 'Initial',
  });
  const visible = visibleBoardSnapshotV1(state);
  const originalFirst = state.liveSnapshot.hitl[0];

  state = applyDurableEventV1(state, secondHitlEvent);

  assert.equal(visibleBoardSnapshotV1(state), visible);
  assert.equal(state.liveSnapshot.hitl.length, 2);
  assert.equal(state.liveSnapshot.hitl[0], originalFirst);
  assert.deepEqual(state.liveSnapshot.hitl.map((item) => item.hitlRequestId), ['hitl_1', 'hitl_2']);
  assert.deepEqual(state.liveSnapshot.hitl[1], secondHitlEvent.data.hitl);

  state = applyDurableEventV1(state, answeredSecondHitlEvent);

  assert.equal(visibleBoardSnapshotV1(state), visible);
  assert.equal(state.liveSnapshot.hitl.length, 2);
  assert.equal(state.liveSnapshot.hitl[0], originalFirst);
  assert.deepEqual(state.liveSnapshot.hitl.map((item) => item.hitlRequestId), ['hitl_1', 'hitl_2']);
  assert.deepEqual(state.liveSnapshot.hitl[1], answeredSecondHitlEvent.data.hitl);
});

test('wrong-board durable HITL fails closed without changing the input state', () => {
  const state = createLiveBoardStateV1({ ...first, hitl: [hitlEvent.data.hitl] });
  const liveSnapshot = state.liveSnapshot;

  assert.throws(() => applyDurableEventV1(state, wrongBoardHitlEvent), /durable event targets another board/u);
  assert.equal(state.liveSnapshot, liveSnapshot);
  assert.deepEqual(state.liveSnapshot.hitl, [hitlEvent.data.hitl]);
});
