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
