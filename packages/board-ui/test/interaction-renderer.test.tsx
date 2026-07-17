import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardSnapshotParserV1,
  HitlInteractionParserV1,
  type BoardSnapshotV1,
  type HitlInteractionV1,
  type HitlRequestDefinitionV1,
} from '@leecat-board/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  HitlBlock,
  validateHitlFormV1,
  type HitlInteractionControllerV1,
} from '../src/interaction/index.js';
import { BoardRenderer } from '../src/renderer/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../board-schema/test/fixtures/valid/${name}`, import.meta.url), 'utf8')) as unknown;

const interaction = (definition: HitlRequestDefinitionV1, state: HitlInteractionV1['state'] = 'open'): HitlInteractionV1 => {
  const terminal = state !== 'open';
  const parsed = HitlInteractionParserV1.parse({
    hitlRequestId: 'hitl_1',
    definition,
    state,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-16T00:15:00.000Z',
    stateUpdatedAt: terminal ? '2026-07-16T00:01:00.000Z' : '2026-07-16T00:00:00.000Z',
    response: null,
    answeredAt: null,
  });
  if (!parsed.ok) throw new TypeError('invalid interaction test fixture');
  return parsed.data.value;
};

const controller = (mode: HitlInteractionControllerV1['mode'] = 'live'): HitlInteractionControllerV1 => ({
  mode,
  isSubmitting: () => false,
  submit: async () => undefined,
  submissionState: () => ({ kind: 'idle' }),
  retry: async () => undefined,
  canCopy: () => false,
  copy: async () => undefined,
  copyState: () => ({ kind: 'idle', message: 'Not copied.' }),
});

const snapshot = (): BoardSnapshotV1 => {
  const base = fixture('snapshot-board.v1.json') as Record<string, unknown>;
  const parsed = BoardSnapshotParserV1.parse({
    ...base,
    scene: fixture('scene-all-node-types.v1.json'),
    hitl: [fixture('hitl-interaction-open.v1.json')],
    artifacts: [fixture('artifact-runtime-summary-ready.v1.json')],
  });
  if (!parsed.ok) throw new TypeError('invalid snapshot fixture');
  return parsed.data.value;
};

test('D8 active seam replaces only the certified HITL placeholder', () => {
  const current = snapshot();
  const html = renderToStaticMarkup(
    <BoardRenderer
      snapshot={current}
      renderHitl={({ node, context }) => {
        const hitl = context.snapshot.hitl.find((item) => item.hitlRequestId === node.hitlRequestId);
        assert.ok(hitl);
        return <HitlBlock nodeId={node.id} boardId={context.snapshot.boardId} expectedRevisionId={context.snapshot.revision.revisionId} interaction={hitl} controller={controller()} />;
      }}
    />,
  );
  assert.match(html, /Information/u);
  assert.match(html, />OK</u);
  assert.doesNotMatch(html, /Response unavailable/u);
});

test('history mode is structurally read-only and exposes no response button', () => {
  const current = snapshot();
  const hitl = current.hitl[0];
  assert.ok(hitl);
  const html = renderToStaticMarkup(
    <HitlBlock nodeId="node_hitl" boardId={current.boardId} expectedRevisionId={current.revision.revisionId} interaction={hitl} controller={controller('history')} />,
  );
  assert.match(html, /Historical view — return to Latest to respond\./u);
  assert.doesNotMatch(html, /<button/u);
});

test('destructive confirmation has non-approval first and no one-step positive action', () => {
  const current = snapshot();
  const hitl = interaction({
    kind: 'confirmation', title: 'Delete board data', body: 'This cannot be undone.',
    impact: 'destructive', confirmLabel: 'Delete permanently', cancelLabel: 'Keep data',
  });
  const html = renderToStaticMarkup(
    <HitlBlock nodeId="node_hitl" boardId={current.boardId} expectedRevisionId={current.revision.revisionId} interaction={hitl} controller={controller()} />,
  );
  assert.match(html, /Destructive confirmation required/u);
  assert.match(html, /This action may be irreversible\. Nothing happens unless you explicitly confirm\./u);
  assert.ok(html.indexOf('Keep data') < html.indexOf('Review impact'));
  assert.doesNotMatch(html, /Delete permanently/u);
});

test('form validation returns exact typed values and rejects required null', () => {
  const definition: Extract<HitlRequestDefinitionV1, { kind: 'form' }> = {
    kind: 'form',
    title: 'Details',
    fields: [
      { id: 'name' as never, type: 'text', label: 'Name', required: true, defaultValue: null, minLength: 2, maxLength: 10 },
      { id: 'count' as never, type: 'number', label: 'Count', required: false, defaultValue: null, min: 1, max: 3 },
      { id: 'ready' as never, type: 'boolean', label: 'Ready', required: true, defaultValue: null },
    ],
    submitLabel: 'Send',
  };
  const invalid = validateHitlFormV1(definition, { name: null, count: null, ready: null });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(Object.keys(invalid.errors), ['name', 'ready']);
  const valid = validateHitlFormV1(definition, { name: 'Lee', count: 2, ready: false });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.response, { kind: 'form', values: { name: 'Lee', count: 2, ready: false } });
});
