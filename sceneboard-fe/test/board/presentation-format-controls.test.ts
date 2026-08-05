import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { reconcileAcceptedPresentationFormatMutationV1 } from '../../lib/board/use-board-session';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('format control exposes the four canonical document formats and is permission-gated', () => {
  const component = source('components/board/PresentationFormatControls.tsx');
  const exportControl = source('components/board/BoardExportControl.tsx');
  const ownerControls = source('components/board/OwnerAdminControls.tsx');
  for (const format of ['wide_16_9', 'standard_4_3', 'a4_portrait', 'a4_landscape'])
    assert.match(component, new RegExp(`'${format}'`, 'u'));
  assert.match(component, /disabled=\{!canEdit \|\| pending\}/u);
  assert.match(component, /if \(next === value \|\| pending \|\| !canEdit\) return/u);
  assert.match(exportControl, /<PresentationFormatControls/u);
  assert.doesNotMatch(ownerControls, /<PresentationFormatControls/u);
});

test('format authoring emits one V3 mutation while view controls remain local-only', () => {
  const component = source('components/board/PresentationFormatControls.tsx');
  const session = source('lib/board/use-board-session.ts');
  const change = session.slice(
    session.indexOf('const changePresentationFormat'),
    session.indexOf('return {', session.indexOf('const changePresentationFormat')),
  );
  assert.equal((change.match(/api\.replaceDocument\(/gu) ?? []).length, 1);
  assert.match(change, /state\?\.mode\.kind !== 'live'/u);
  assert.match(change, /authorizationCapabilities\.includes\('board\.write'\)/u);
  assert.match(change, /command: \{ type: 'document\.replace', document \}/u);
  assert.match(component, /setSelected\(next\)/u);
  assert.match(component, /if \(!ok\) setSelected\(value\)/u);

  for (const relative of [
    'components/board/PageDisplayModeControls.tsx',
    'components/board/PageMoveModeControls.tsx',
    'components/board/PresentationModeControls.tsx',
  ]) {
    const control = source(relative);
    assert.doesNotMatch(control, /replaceDocument|replaceDocumentV3|transformDocument|mutations/u);
  }
});

test('an accepted format mutation stays successful when the board refresh fails', async () => {
  let refreshCalls = 0;
  const replaceDocument = async () => ({ kind: 'ok' as const });
  const getBoard = async () => {
    refreshCalls += 1;
    return false;
  };

  const mutation = await replaceDocument();
  assert.equal(mutation.kind, 'ok');
  const saved = await reconcileAcceptedPresentationFormatMutationV1(getBoard);
  const announcesSaveFailure = !saved;

  assert.equal(refreshCalls, 1);
  assert.equal(saved, true);
  assert.equal(announcesSaveFailure, false);
});
