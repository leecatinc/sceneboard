import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CurrentHitlSummaryProvider } from '../../src/interactions/current-hitl-summary.provider.js';
import { extractUniqueSceneHitlRequestIds } from '../../src/revisions/scene-hitl-reference.extractor.js';

test('extracts unique HITL references in first scene order and checks open HITL for an empty scene', async () => {
  const scene = {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'root',
      type: 'layout.split',
      direction: 'horizontal',
      children: [
        { size: 1, node: { id: 'one', type: 'content.hitl', hitlRequestId: 'hitl_2' } },
        { size: 1, node: { id: 'two', type: 'content.hitl', hitlRequestId: 'hitl_1' } },
        { size: 1, node: { id: 'three', type: 'content.hitl', hitlRequestId: 'hitl_2' } },
      ],
    },
  } as never;
  assert.deepEqual(extractUniqueSceneHitlRequestIds(scene), ['hitl_2', 'hitl_1']);
  let queries = 0;
  const provider = new CurrentHitlSummaryProvider();
  const result = await provider.readAuthorizedAtCut({
    execute: async () => { queries += 1; return [[], []]; },
  } as never, {
    boardId: 'board_1',
    scene: { protocolVersion: 1, type: 'scene', root: null },
    lastEventSequence: 0,
  } as never);
  assert.deepEqual(result, []);
  assert.equal(queries, 1);
});

test('projects referenced rows in first-scene order and enforces the inclusive event watermark', async () => {
  const definition = Buffer.from(JSON.stringify({
    acknowledgeLabel: 'OK', body: 'Read this.', kind: 'info', title: 'Information',
  }));
  const row = (inputOrdinal: number, hitlRequestId: string, sequence = '4') => ({
    inputOrdinal,
    hitlPk: String(inputOrdinal + 1),
    boardPk: '2',
    hitlRequestId,
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
    createdRequestId: `request_${inputOrdinal + 1}`,
    answeredRequestId: null,
    createdEventSequence: sequence,
    stateEventSequence: sequence,
    createdAt: '2026-07-16 00:00:00.000',
    expiresAt: '2026-07-16 00:15:00.000',
    stateUpdatedAt: '2026-07-16 00:00:00.000',
    answeredAt: null,
  });
  const scene = {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'root',
      type: 'layout.split',
      direction: 'horizontal',
      children: [
        { size: 1, node: { id: 'one', type: 'content.hitl', hitlRequestId: 'hitl_2' } },
        { size: 1, node: { id: 'two', type: 'content.hitl', hitlRequestId: 'hitl_1' } },
      ],
    },
  } as never;
  let binds: unknown[] = [];
  const provider = new CurrentHitlSummaryProvider();
  const summaries = await provider.readAuthorizedAtCut({
    execute: async (sql: string, input: unknown[]) => {
      if (sql.includes("i.state_code = 'O'")) return [[], []];
      binds = input;
      return [[row(0, 'hitl_2'), row(1, 'hitl_1')], []];
    },
  } as never, { boardId: 'board_1', scene, lastEventSequence: 4 } as never);
  assert.deepEqual(summaries.map((item) => item.hitlRequestId), ['hitl_2', 'hitl_1']);
  assert.deepEqual(binds, [0, 'hitl_2', 1, 'hitl_1', 'board_1']);
  await assert.rejects(provider.readAuthorizedAtCut({
    execute: async (sql: string) => sql.includes("i.state_code = 'O'")
      ? [[], []]
      : [[row(0, 'hitl_2', '5'), row(1, 'hitl_1', '5')], []],
  } as never, { boardId: 'board_1', scene, lastEventSequence: 4 } as never));
});

test('appends open HITL without a scene node and avoids duplicating referenced interactions', async () => {
  const definition = Buffer.from(JSON.stringify({
    acknowledgeLabel: 'OK', body: 'Read this.', kind: 'info', title: 'Information',
  }));
  const row = (hitlRequestId: string, hitlPk: string, sequence = '4') => ({
    hitlPk,
    boardPk: '2',
    hitlRequestId,
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
    createdRequestId: `request_${hitlPk}`,
    answeredRequestId: null,
    createdEventSequence: sequence,
    stateEventSequence: sequence,
    createdAt: '2026-07-16 00:00:00.000',
    expiresAt: '2026-07-16 00:15:00.000',
    stateUpdatedAt: '2026-07-16 00:00:00.000',
    answeredAt: null,
  });
  const scene = {
    protocolVersion: 1,
    type: 'scene',
    root: { id: 'one', type: 'content.hitl', hitlRequestId: 'hitl_1' },
  } as never;
  const provider = new CurrentHitlSummaryProvider();
  const summaries = await provider.readAuthorizedAtCut({
    execute: async (sql: string) => sql.includes("i.state_code = 'O'")
      ? [[row('hitl_1', '1'), row('hitl_2', '2')], []]
      : [[{ inputOrdinal: 0, ...row('hitl_1', '1') }], []],
  } as never, { boardId: 'board_1', scene, lastEventSequence: 4 } as never);
  assert.deepEqual(summaries.map((item) => item.hitlRequestId), ['hitl_1', 'hitl_2']);
});
