import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { BoardEventEnvelopeParserV1 } from '@leecat-board/board-schema';

import { InteractionIntegrityProbe } from '../../src/interactions/persistence/interaction-integrity.probe.js';

const EVENT_ID = '123e4567-e89b-42d3-a456-426614174000';

const definition = Buffer.from(JSON.stringify({
  acknowledgeLabel: 'OK',
  body: 'Read this.',
  kind: 'info',
  title: 'Information',
}));

const eventPayload = (): Buffer => {
  const parsed = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: 'board_1',
    eventId: EVENT_ID,
    sequence: 4,
    occurredAt: '2026-07-16T00:00:00.000Z',
    revisionId: null,
    data: {
      type: 'hitl.updated',
      hitl: {
        hitlRequestId: 'hitl_1',
        definition: { kind: 'info', title: 'Information', body: 'Read this.', acknowledgeLabel: 'OK' },
        state: 'open',
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2026-07-16T00:15:00.000Z',
        stateUpdatedAt: '2026-07-16T00:00:00.000Z',
        response: null,
        answeredAt: null,
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid fixture');
  return Buffer.from(parsed.data.canonicalBytes);
};

const row = () => {
  const payload = eventPayload();
  return {
    hitlPk: '1',
    boardPk: '2',
    hitlRequestId: 'hitl_1',
    definitionKind: 'I',
    definitionPayload: definition,
    definitionCanonicalBytes: definition.byteLength,
    definitionSha256: createHash('sha256').update(definition).digest(),
    stateCode: 'O',
    responseKind: null,
    responsePayload: null,
    responseCanonicalBytes: null,
    responseSha256: null,
    createdByKind: 'U',
    createdByPrincipalId: 'user_1',
    createdByGrantId: null,
    answeredByKind: null,
    answeredByPrincipalId: null,
    answeredByGrantId: null,
    terminalByKind: null,
    terminalByPrincipalId: null,
    terminalByGrantId: null,
    supersededByRequestId: null,
    createdRequestId: 'request_1',
    answeredRequestId: null,
    createdEventSequence: '4',
    stateEventSequence: '4',
    createdAt: '2026-07-16 00:00:00.000',
    expiresAt: '2026-07-16 00:15:00.000',
    stateUpdatedAt: '2026-07-16 00:00:00.000',
    answeredAt: null,
    boardId: 'board_1',
    headLastEventSequence: '4',
    successorHitlPk: null,
    successorCreatedAt: null,
    createdEventId: Buffer.from(EVENT_ID.replaceAll('-', ''), 'hex'),
    createdEventSequenceActual: '4',
    createdEventType: 'hitl.updated',
    createdEventRevisionPk: null,
    createdEventPayload: payload,
    createdEventCanonicalBytes: payload.byteLength,
    createdEventSha256: createHash('sha256').update(payload).digest(),
    stateEventId: Buffer.from(EVENT_ID.replaceAll('-', ''), 'hex'),
    stateEventSequenceActual: '4',
    stateEventType: 'hitl.updated',
    stateEventRevisionPk: null,
    stateEventPayload: payload,
    stateEventCanonicalBytes: payload.byteLength,
    stateEventSha256: createHash('sha256').update(payload).digest(),
  };
};

test('checks a bounded resumable interaction/event batch and fails closed on event corruption', async () => {
  const probe = new InteractionIntegrityProbe();
  let binds: unknown[] = [];
  let statement = '';
  const valid = await probe.inspectBatch({
    execute: async (sql: string, input: unknown[]) => {
      statement = sql;
      binds = input;
      return [[row()], []];
    },
  } as never, { mode: 'RESUMABLE_AUDIT', afterHitlPk: null, limit: 2 });
  assert.deepEqual(valid, {
    mode: 'RESUMABLE_AUDIT', checked: 1, complete: true, nextAfterHitlPk: '1',
  });
  assert.match(statement, /LIMIT 2/u);
  assert.deepEqual(binds, ['0']);
  await assert.rejects(probe.inspectBatch({
    execute: async () => [[{ ...row(), stateEventSha256: Buffer.alloc(32) }], []],
  } as never, { mode: 'FULL_OFFLINE', afterHitlPk: null, limit: 100 }));
});
