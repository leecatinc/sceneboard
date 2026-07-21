import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  mapInteractionRowV1,
  type InteractionRowV1,
} from '../../src/interactions/persistence/interaction-row.mapper.js';

const definition = Buffer.from(
  JSON.stringify({
    acknowledgeLabel: 'OK',
    body: 'Read this.',
    kind: 'info',
    title: 'Information',
  }),
);

const row = (): InteractionRowV1 =>
  ({
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
  }) as InteractionRowV1;

test('maps one canonical open interaction and preserves the exact fifteen-minute expiry', () => {
  const stored = mapInteractionRowV1(row());
  assert.equal(stored.interaction.state, 'open');
  assert.equal(stored.interaction.createdAt, '2026-07-16T00:00:00.000Z');
  assert.equal(stored.interaction.expiresAt, '2026-07-16T00:15:00.000Z');
  assert.equal(stored.createdEventSequence, 4);
  assert.equal(stored.stateEventSequence, 4);
});

test('fails closed on digest, actor, sequence, and expired-clock drift', () => {
  assert.throws(() => mapInteractionRowV1({ ...row(), definitionSha256: Buffer.alloc(32) }));
  assert.throws(() =>
    mapInteractionRowV1({ ...row(), createdByKind: 'M', createdByGrantId: null }),
  );
  assert.throws(() => mapInteractionRowV1({ ...row(), stateEventSequence: '5' }));
  assert.throws(() =>
    mapInteractionRowV1({
      ...row(),
      stateCode: 'E',
      stateEventSequence: '5',
      terminalByKind: 'S',
      terminalByPrincipalId: 'hitl-expiry-v1',
      stateUpdatedAt: '2026-07-16 00:15:00.001',
    }),
  );
});
