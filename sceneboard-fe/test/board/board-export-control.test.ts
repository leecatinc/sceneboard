import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('owner export confirmation pins revision, document format and exact server retryability', () => {
  const control = source('components/board/BoardExportControl.tsx');
  const client = source('app/boards/[boardId]/board-client.tsx');
  assert.match(control, /setTarget\(\{\s*boardId,\s*boardTitle,\s*revisionId,\s*revisionNumber/su);
  assert.match(control, /revisionId: target\.revisionId,\s*format: requestFormat/su);
  assert.match(control, /retry \? requestFormatRef\.current : format/u);
  assert.match(control, /if \(!retry\) requestFormatRef\.current = requestFormat/u);
  assert.match(control, /boards\.revision/);
  assert.match(control, /formatLabelKey\(target\.documentFormat\)/);
  assert.match(control, /state\.failure\?\.retryable === true/);
  assert.match(control, /disabled=\{state\.phase !== 'confirming' && state\.phase !== 'idle'\}/u);
  assert.doesNotMatch(control, /status\s*===\s*(429|500|503|504)/u);
  assert.match(client, /affordances\['export\.render'\]/u);
  assert.match(client, /visibleSnapshot\.revision\.revisionId/u);
  assert.match(client, /visibleSnapshot\.revision\.revisionNumber/u);
});

test('export control has closed confirming, generating, completed, failed and retry states', () => {
  const control = source('components/board/BoardExportControl.tsx');
  for (const phase of ['idle', 'confirming', 'generating', 'completed', 'failed', 'retry'])
    assert.match(control, new RegExp(`'${phase}'`, 'u'));
  assert.match(control, /controller\.signal\.aborted/u);
  assert.match(control, /requestRef\.current !== controller/u);
  assert.match(control, /publishBoardExportDownloadV1\(result\.value/u);
  assert.match(control, /document\.body\.append\(anchor\)/u);
  assert.match(control, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/u);
  assert.match(control, /requestRef\.current\?\.abort\(\)/u);
});

test('initial export exceptions leave generating through the browser-unavailable failure contract', () => {
  const control = source('components/board/BoardExportControl.tsx');
  assert.match(control, /setState\(\{ phase: retry \? 'retry' : 'generating', failure: null \}\)/u);
  assert.match(
    control,
    /try \{[\s\S]*await api\.export\([\s\S]*publishBoardExportDownloadV1\([\s\S]*\} catch \{[\s\S]*phase: 'failed',[\s\S]*code: 'EXPORT_BROWSER_UNAVAILABLE', retryable: false/u,
  );
});

test('retry exceptions fail deterministically while aborted or stale requests preserve newer state', () => {
  const control = source('components/board/BoardExportControl.tsx');
  assert.match(control, /const requestFormat = retry \? requestFormatRef\.current : format/u);
  assert.match(
    control,
    /\} catch \{\s*if \(controller\.signal\.aborted \|\| requestRef\.current !== controller\) return;\s*requestRef\.current = null;\s*setState\(\{\s*phase: 'failed',\s*failure: \{ code: 'EXPORT_BROWSER_UNAVAILABLE', retryable: false \}/u,
  );
});

test('export dialog restores focus, announces status and remains usable at 320px', () => {
  const control = source('components/board/BoardExportControl.tsx');
  const styles = source('components/board/BoardExportControl.module.css');
  assert.match(control, /requestAnimationFrame\(\(\) => triggerRef\.current\?\.focus\(\)\)/u);
  assert.match(control, /aria-labelledby=\{titleId\}/u);
  assert.match(control, /aria-describedby=\{descriptionId\}/u);
  assert.match(control, /aria-live="polite"/u);
  assert.match(control, /onCancel=\{\(event\) =>/u);
  assert.match(styles, /@media \(max-width: 320px\)/u);
  assert.match(styles, /width: 100vw/u);
});

test('export UI has no credential, persistence, analytics or board-mutation sink', () => {
  const control = source('components/board/BoardExportControl.tsx');
  const adapter = source('lib/api/board-export-api.ts');
  for (const forbidden of [
    'localStorage',
    'sessionStorage',
    'Authorization',
    'Bearer',
    'pairing',
    'analytics',
    '/mutations',
    'console.',
  ]) {
    assert.equal(control.includes(forbidden), false, forbidden);
    assert.equal(adapter.includes(forbidden), false, forbidden);
  }
});
