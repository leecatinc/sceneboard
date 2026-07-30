import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../components/board/HistoryControls.tsx', import.meta.url),
  'utf8',
);
const styles = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

test('uses one select-only combobox and retained options instead of navigation buttons', () => {
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-expanded=\{history\.isOpen\}/);
  assert.match(source, /aria-controls=\{LISTBOX_ID\}/);
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.doesNotMatch(source, /onPrevious|onNext|board\.previous|board\.next/);
});

test('owns the complete keyboard, retry, announcement, and bounded mobile surface', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'PageDown', 'Home', 'End', 'Tab'])
    assert.match(source, new RegExp(`event\\.key === '${key}'`));
  assert.match(source, /role="status" aria-live="polite"/);
  assert.match(source, /ref=\{retryRef\}/);
  assert.match(source, /onPointerMove/);
  assert.match(styles, /width: min\(360px, calc\(100vw - 24px\)\)/);
  assert.match(styles, /max-height: min\(360px, 55vh\)/);
  assert.match(styles, /overflow-y: auto/);
  assert.match(styles, /touch-action: manipulation/);
});

test('renders only normalized privacy-safe history fields', () => {
  assert.match(source, /row\.label/);
  assert.match(source, /row\.actorLabel/);
  assert.match(source, /row\.summary/);
  assert.doesNotMatch(source, /principalId|email|grantId|hold|recovery|sourceRevisionId/);
});

test('each history presentation keeps one visible error and a visually hidden live region', () => {
  // Both sidebar and mobile combobox variants keep the live region for assistive tech.
  assert.match(source, /history-live-region visually-hidden/);
  assert.match(source, /role="status" aria-live="polite"/);
  // Each variant renders its own visible error block exactly once.
  const errorBlocks = source.match(
    /history\.status === 'error' && \(\s*<div className="history-popup-state">/g,
  );
  assert.equal(errorBlocks?.length ?? 0, 2);
});

test('trigger carries a compact warning state and busy semantics during history load', () => {
  assert.match(source, /history-trigger\$\{history\.status === 'error' \? ' is-warning' : ''\}/);
  assert.match(
    source,
    /history-trigger-caret\$\{history\.status === 'error' \? ' is-warning' : ''\}/,
  );
  assert.match(
    source,
    /aria-busy=\{history\.status === 'loading' \|\| history\.status === 'loading_more'\}/,
  );
  assert.match(styles, /\.history-trigger\.is-warning\b/);
  assert.match(styles, /\.history-trigger-caret\.is-warning::after/);
});

test('retry copy reloads history instead of the ambiguous retry-again wording', () => {
  const catalog = readFileSync(
    new URL('../../lib/i18n/catalogs/presentation.ts', import.meta.url),
    'utf8',
  );
  assert.match(catalog, /'board\.historyRetry',\n\s+'Reload history',\n\s+'다시 불러오기'/);
});
