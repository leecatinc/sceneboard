import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('raw public link identity is absent from every client-owned source contract', () => {
  for (const path of [
    'app/s/[shareToken]/shared-board-client.tsx',
    'lib/api/public-share-contract.ts',
    'lib/board/public-share-viewer-state.ts',
    'lib/board/public-page-render-adapter.ts',
  ])
    assert.doesNotMatch(source(path), /shareToken/u, path);
});

test('server entry binds the raw identity and returns only token-free state/action references', () => {
  const page = source('app/s/[shareToken]/page.tsx');
  assert.match(page, /const \{ shareToken \} = await params/u);
  assert.match(page, /bootstrapSharedBoard\(shareToken\)/u);
  assert.match(page, /bootstrapSharedBoard\.bind\(null, shareToken\)/u);
  assert.match(page, /submitSharedBoardPassword\.bind\(null, shareToken\)/u);
  assert.doesNotMatch(page, /data-|href=|value=|console\.|analytics/u);
});
