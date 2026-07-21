import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HitlInteractionParserV1,
  type BoardId,
  type HitlInteractionV1,
  type HitlResponseV1,
} from '@sceneboard/board-schema';

import { buildHitlClipboardPayloadV1 } from '../../lib/board/use-hitl-interaction-controller';

const root = new URL('../../', import.meta.url);
const fixture = (name: string): HitlInteractionV1 => {
  const value = JSON.parse(
    readFileSync(
      new URL(`../../../packages/board-schema/test/fixtures/valid/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
  const parsed = HitlInteractionParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid HITL fixture');
  return parsed.data.value;
};
const boardId = 'board_1' as BoardId;

test('clipboard formats always carry exact board, interaction, and typed response identity', () => {
  const answered = buildHitlClipboardPayloadV1({
    boardId,
    interaction: fixture('hitl-interaction-answered.v1.json'),
  });
  assert.match(answered ?? '', /^\[SceneBoard HITL response\] board board_1, request hitl_1/u);
  assert.match(answered ?? '', /Recorded response: \{"kind":"info","acknowledged":true\}/u);

  const expired = buildHitlClipboardPayloadV1({
    boardId,
    interaction: fixture('hitl-interaction-expired.v1.json'),
  });
  assert.match(expired ?? '', /^\[SceneBoard HITL expired\]/u);
  assert.match(expired ?? '', /Do not assume an answer/u);

  const open = fixture('hitl-interaction-open.v1.json');
  const unknown = buildHitlClipboardPayloadV1({
    boardId,
    interaction: open,
    recordingUnknownResponse: { kind: 'info', acknowledged: true },
  });
  assert.match(unknown ?? '', /RECORDING UNKNOWN, reconcile first/u);
  assert.match(unknown ?? '', /board_interaction_status/u);
  assert.match(unknown ?? '', /\{"kind":"info","acknowledged":true\}/u);
});

test('destructive positive confirmation has no recording-unknown clipboard path', () => {
  const parsed = HitlInteractionParserV1.parse({
    ...fixture('hitl-interaction-open.v1.json'),
    definition: {
      kind: 'confirmation',
      title: 'Delete',
      body: 'Delete permanently?',
      impact: 'destructive',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const positive: HitlResponseV1 = { kind: 'confirmation', confirmed: true };
  const negative: HitlResponseV1 = { kind: 'confirmation', confirmed: false };
  assert.equal(
    buildHitlClipboardPayloadV1({
      boardId,
      interaction: parsed.data.value,
      recordingUnknownResponse: positive,
    }),
    null,
  );
  assert.match(
    buildHitlClipboardPayloadV1({
      boardId,
      interaction: parsed.data.value,
      recordingUnknownResponse: negative,
    }) ?? '',
    /RECORDING UNKNOWN/u,
  );
});

test('route integration binds D8 only through the renderer seam and preserves history mode', () => {
  const boardClient = readFileSync(new URL('app/boards/[boardId]/board-client.tsx', root), 'utf8');
  const hook = readFileSync(new URL('lib/board/use-hitl-interaction-controller.ts', root), 'utf8');
  assert.match(boardClient, /renderHitl=\{renderHitl\}/u);
  assert.match(boardClient, /state\.mode\.kind === 'history' \? 'history' : 'live'/u);
  assert.match(hook, /same|idempotencyKey/u);
  assert.doesNotMatch(hook, /localStorage|sessionStorage/u);
});
