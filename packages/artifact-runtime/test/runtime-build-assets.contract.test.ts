import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('runtime build owns deterministic classic outer, inner, Mermaid, and atomic staging', async () => {
  const source = await readFile(new URL('../scripts/build-runtime-assets.mjs', import.meta.url), 'utf8');
  assert.match(source, /format: 'iife'/u);
  assert.match(source, /target: \['es2022'\]/u);
  assert.match(source, /mermaid\.min\.js/u);
  assert.match(source, /fixed-assets\.v1\.json/u);
  assert.match(source, /rename\(staging, output\)/u);
  assert.doesNotMatch(source, /https?:\/\//u);
});

test('runner sources do not use app-origin execution shortcuts', async () => {
  const [outer, inner] = await Promise.all([
    readFile(new URL('../src/runner/outer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runner/inner-bootstrap.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of [outer, inner]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|srcdoc|eval\(|new Function/u);
  }
  assert.match(outer, /setAttribute\('sandbox', INNER_SANDBOX_TOKENS_V1\)/u);
});
