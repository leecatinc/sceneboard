import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardEventEnvelopeParserV1,
  BoardEventEnvelopeParserV2,
  DEFAULT_BOARD_CAPABILITIES_V2,
  type BoardId,
  type BoardSnapshotV1,
  type BoardSnapshotV2,
  type EventId,
} from '@sceneboard/board-schema';

import { BoardStreamCutService } from '../../src/sse/board-stream-cut.service.js';
import { SseCursorCodec } from '../../src/sse/sse-cursor.codec.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';

const snapshotFixture = (): BoardSnapshotV1 => {
  const source = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/board-schema/test/fixtures/valid/event-board-snapshot.v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { data: { snapshot: BoardSnapshotV1 } };
  return source.data.snapshot;
};

const principal = {
  kind: 'user',
  actor: { principalKind: 'user', principalId: 'user_1', grantId: null },
  userPk: 1n,
  sessionPk: 1n,
  familyPublicId: 'family_1',
} as const;

test('no cursor yields one synthetic snapshot envelope and bound signed cursor', async () => {
  const snapshot = snapshotFixture();
  const codec = new SseCursorCodec(new RedisStreamKeyspace(Buffer.alloc(32, 12)));
  const service = new BoardStreamCutService(
    { get: async () => ({ result: { type: 'board.get', snapshot } }) } as never,
    {} as never,
    codec,
    { generatePublicIdV1: () => 'request_1' } as never,
  );
  const cut = await service.prepare(principal as never, snapshot.boardId, null);
  assert.equal(cut.frames.length, 1);
  const frame = cut.frames[0]!;
  assert.equal(frame.envelope.data.type, 'board.snapshot');
  assert.equal(frame.envelope.sequence, snapshot.lastEventSequence);
  assert.match(frame.envelope.eventId, /^sse_snapshot_[A-Za-z0-9_-]{22}$/u);
  const cursor = codec.decode(frame.cursor);
  assert.equal(cursor.k, 'snapshot');
  assert.equal(cursor.b, snapshot.boardId);
  assert.equal(cursor.s, snapshot.lastEventSequence);
  assert.equal(cursor.e, frame.envelope.eventId);
});

test('no cursor emits a negotiated v2 document snapshot cut without a legacy Scene cast', async () => {
  const base = snapshotFixture();
  const { scene: _scene, ...shared } = base;
  const snapshot = {
    ...shared,
    revision: {
      ...base.revision,
      revisionId: 'revision_v2',
      revisionNumber: 2,
      previousRevisionId: base.revision.revisionId,
      originType: 'document.replace',
      sourceRevisionId: null,
    },
    document: {
      schemaVersion: 2,
      defaultPageId: 'page_1',
      pages: [
        {
          pageId: 'page_1',
          title: '',
          displayMode: 'fit-page',
          scene: { protocolVersion: 1, type: 'scene', root: null },
        },
      ],
    },
    capabilities: {
      ...DEFAULT_BOARD_CAPABILITIES_V2,
      supported: {
        ...DEFAULT_BOARD_CAPABILITIES_V2.supported,
        nodeTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.nodeTypes],
        commandTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.commandTypes],
        operationTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.operationTypes],
        eventTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.eventTypes],
        hitlKinds: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.hitlKinds],
        artifactRequestCapabilities: [
          ...DEFAULT_BOARD_CAPABILITIES_V2.supported.artifactRequestCapabilities,
        ],
      },
      limits: { ...DEFAULT_BOARD_CAPABILITIES_V2.limits },
      grantedCapabilities: [...base.capabilities.grantedCapabilities],
      allowedArtifactRequestCapabilities: [...base.capabilities.allowedArtifactRequestCapabilities],
    },
  } as BoardSnapshotV2;
  const codec = new SseCursorCodec(new RedisStreamKeyspace(Buffer.alloc(32, 13)));
  const service = new BoardStreamCutService(
    { get: async () => ({ result: { type: 'board.get', snapshot } }) } as never,
    {} as never,
    codec,
    { generatePublicIdV1: () => 'request_1' } as never,
  );
  const cut = await service.prepare(principal as never, snapshot.boardId, null);
  const frame = cut.frames[0];
  assert.ok(frame);
  assert.equal(BoardEventEnvelopeParserV2.parseBytes(frame.canonicalBytes).ok, true);
  assert.equal(frame.envelope.data.type, 'board.snapshot');
  if (frame.envelope.data.type === 'board.snapshot') {
    assert.equal('document' in frame.envelope.data.snapshot, true);
  }
});

test('usable snapshot cursor replays only the complete contiguous suffix', async () => {
  const base = snapshotFixture();
  const snapshot = { ...base, lastEventSequence: 2 } as BoardSnapshotV1;
  const event = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: snapshot.boardId,
    eventId: 'event_2',
    sequence: 2,
    occurredAt: '2026-07-16T00:00:01.000Z',
    revisionId: 'revision_2',
    data: {
      type: 'board.revision.created',
      revision: {
        revisionId: 'revision_2',
        revisionNumber: 2,
        createdAt: '2026-07-16T00:00:01.000Z',
      },
      originType: 'scene.clear',
      sourceRevisionId: null,
    },
  });
  assert.equal(event.ok, true);
  if (!event.ok) throw new Error('invalid event fixture');
  const deliverable = {
    eventPk: 2n,
    eventId: event.data.value.eventId,
    boardId: event.data.value.boardId,
    revisionId: event.data.value.revisionId,
    sequence: 2,
    eventType: event.data.value.data.type,
    envelope: event.data.value,
    canonicalBytes: event.data.canonicalBytes,
  };
  const codec = new SseCursorCodec(new RedisStreamKeyspace(Buffer.alloc(32, 13)));
  const cursor = codec.encode({
    v: 1,
    k: 'snapshot',
    b: snapshot.boardId,
    s: 1,
    e: 'sse_snapshot_AAAAAAAAAAAAAAAAAAAAAA' as EventId,
    t: new Date().toISOString() as never,
  });
  const service = new BoardStreamCutService(
    { get: async () => ({ result: { type: 'board.get', snapshot } }) } as never,
    { listContiguousEvents: async () => [deliverable] } as never,
    codec,
    { generatePublicIdV1: () => 'request_1' } as never,
  );
  const cut = await service.prepare(principal as never, snapshot.boardId, cursor);
  assert.equal(cut.frames.length, 1);
  assert.equal(cut.frames[0]?.envelope.eventId, 'event_2');
  assert.equal(cut.sequence, 2);
});

test('a valid cursor bound to another board selects a fresh authorized-board snapshot', async () => {
  const snapshot = snapshotFixture();
  const codec = new SseCursorCodec(new RedisStreamKeyspace(Buffer.alloc(32, 14)));
  const cursor = codec.encode({
    v: 1,
    k: 'snapshot',
    b: 'other_board' as BoardId,
    s: 1,
    e: 'sse_snapshot_AAAAAAAAAAAAAAAAAAAAAA' as EventId,
    t: new Date().toISOString() as never,
  });
  let authorizationReads = 0;
  const service = new BoardStreamCutService(
    {
      get: async () => {
        authorizationReads += 1;
        return { result: { type: 'board.get', snapshot } };
      },
    } as never,
    {} as never,
    codec,
    { generatePublicIdV1: () => 'request_1' } as never,
  );
  const cut = await service.prepare(principal as never, snapshot.boardId, cursor);
  assert.equal(authorizationReads, 1);
  assert.equal(cut.frames[0]?.envelope.data.type, 'board.snapshot');
});
