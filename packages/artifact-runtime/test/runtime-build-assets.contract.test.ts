import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('runtime build owns deterministic classic outer, inner, Mermaid, Three.js, and atomic staging', async () => {
  const [source, runner] = await Promise.all([
    readFile(new URL('../scripts/build-runtime-assets.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runner/runner.html', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /format: 'iife'/u);
  assert.match(source, /target: \['es2022'\]/u);
  assert.match(source, /mermaid\.min\.js/u);
  assert.match(source, /three-global\.ts/u);
  assert.match(source, /logicalName: 'three'/u);
  assert.match(source, /fixed-assets\.v1\.json/u);
  assert.match(source, /rename\(staging, output\)/u);
  assert.doesNotMatch(source, /https?:\/\//u);
  assert.match(runner, /html, body \{ width: 100%; height: 100%; margin: 0; overflow: hidden; \}/u);
  assert.match(
    runner,
    /body > iframe \{ display: block; width: 100%; height: 100%; border: 0; \}/u,
  );
});

test('runner sources do not use app-origin execution shortcuts', async () => {
  const [outer, inner, innerDocument] = await Promise.all([
    readFile(new URL('../src/runner/outer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runner/inner-bootstrap.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runner/inner-document.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of [outer, inner]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|eval\(|new Function/u);
  }
  assert.match(outer, /setAttribute\('sandbox', INNER_SANDBOX_TOKENS_V1\)/u);
  assert.match(outer, /usesOpaqueSrcdoc/u);
  assert.match(outer, /new URL\(outerScript\.src\)\.origin/u);
  assert.doesNotMatch(outer, /document\.baseURI/u);
  assert.match(outer, /frame\.srcdoc =/u);
  assert.match(outer, /data:application\/javascript;base64/u);
  assert.match(outer, /<template id="__sceneboard_artifact_resources_v1__">/u);
  assert.match(innerDocument, /html,body\{width:100%;height:100%;margin:0;overflow:hidden\}/u);
  assert.match(outer, /incoming\.type === 'artifact\.resize\.request'/u);
  assert.match(inner, /artifact\.resize\.request/u);
  assert.match(inner, /requestAnimationFrame/u);
  assert.doesNotMatch(inner, /new ResizeObserver/u);
  assert.match(inner, /nativePortPostMessage/u);
  assert.match(inner, /nativeReflectApply/u);
  assert.match(inner, /nativeStopImmediatePropagation/u);
  assert.match(inner, /nativePerformanceNow/u);
  assert.match(inner, /nativeSetTimeout/u);
  assert.match(inner, /usesOpaqueSrcdoc/u);
  assert.match(inner, /script\.textContent = resources\.javascript/u);
  assert.match(inner, /script\.nonce = inheritedDocumentNonce/u);
  assert.match(inner, /style\.nonce = inheritedDocumentNonce/u);
  assert.doesNotMatch(inner, /\.bind\(/u);
  assert.match(inner, /assertActive\(\)/u);
  assert.match(inner, /event\.isTrusted/u);
  assert.doesNotMatch(outer, /<script nonce="\$\{nonce\}">/u);
});
