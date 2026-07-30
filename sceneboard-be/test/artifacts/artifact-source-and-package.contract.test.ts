import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BoardArtifactPutSourceV1Parser } from '../../src/artifacts/artifact-http.dto.js';
import { ArtifactSanitizerV1 } from '../../src/artifacts/artifact-sanitizer.js';
import { ArtifactSourceNormalizerV1 } from '../../src/artifacts/artifact-source-normalizer.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

const principal = {
  kind: 'user',
  actor: {
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['artifact.publish', 'board.read'],
  },
  userPk: 1n,
  sessionPk: 2n,
  familyPublicId: 'family_1',
} as ResolvedBoardPrincipalV1;

const source = () => ({
  boardId: 'board_1',
  expectedRevisionId: 'revision_1',
  idempotencyKey: 'artifact-key-0001',
  artifactId: null,
  html: '<main><pre class="mermaid">graph TD; A--&gt;B</pre></main>',
  css: 'main { display: grid; gap: 8px }',
  javascript: 'globalThis.rendered = true;',
  requestedCapabilities: ['clipboard.write', 'fullscreen'],
});

test('requires the exact eight source keys, explicit nulls, and sorted unique capabilities', () => {
  assert.equal(BoardArtifactPutSourceV1Parser.parse(source()).ok, true);
  assert.equal(BoardArtifactPutSourceV1Parser.parse({ ...source(), css: undefined }).ok, false);
  assert.equal(BoardArtifactPutSourceV1Parser.parse({ ...source(), requestId: 'extra' }).ok, false);
  assert.equal(
    BoardArtifactPutSourceV1Parser.parse({
      ...source(),
      requestedCapabilities: ['fullscreen', 'clipboard.write'],
    }).ok,
    false,
  );
  assert.equal(
    BoardArtifactPutSourceV1Parser.parse({
      ...source(),
      requestedCapabilities: ['fullscreen', 'fullscreen'],
    }).ok,
    false,
  );
});

test('rejects active HTML and URL-bearing CSS through structural parsers', () => {
  const normalizer = new ArtifactSourceNormalizerV1();
  for (const input of [
    { ...source(), html: '<script>alert(1)</script>' },
    { ...source(), html: '<a href="https://example.com">outside</a>' },
    { ...source(), css: 'main { background: url(https://example.com/a.png) }' },
  ]) {
    const parsed = BoardArtifactPutSourceV1Parser.parseOrThrow(input);
    assert.throws(() => normalizer.normalize({ principal, source: parsed }), /Invalid payload/u);
  }
});

test('builds deterministic one-to-three resource manifests and LCARTV1 packages', () => {
  const normalizer = new ArtifactSourceNormalizerV1();
  const parsed = BoardArtifactPutSourceV1Parser.parseOrThrow(source());
  const first = normalizer.normalize({ principal, source: parsed });
  const second = normalizer.normalize({ principal, source: parsed });
  assert.equal(first.manifest.artifact.artifactId.length, 22);
  assert.equal(first.manifest.artifact.versionId.length, 22);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.packageBytes, second.packageBytes);
  assert.equal(first.packageBytes.subarray(0, 8).toString('ascii'), 'LCARTV1\0');
  assert.deepEqual(
    first.manifest.resources.map((item) => [item.path, item.mediaType]),
    [
      ['index.html', 'text/html'],
      ['styles.css', 'text/css'],
      ['main.js', 'text/javascript'],
    ],
  );
  const minimal = normalizer.normalize({
    principal,
    source: BoardArtifactPutSourceV1Parser.parseOrThrow({
      ...source(),
      css: null,
      javascript: null,
    }),
  });
  assert.equal(minimal.manifest.resources.length, 1);
});

test('accepts the compiler-owned KitCatHub slide deck through the production sanitizer', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const cli = join(
    root,
    'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact.mjs',
  );
  const fixture = join(root, 'test/fixtures/kitcathub-slide-deck.json');
  const draft = JSON.parse(
    execFileSync(process.execPath, [cli, 'compile', fixture], { encoding: 'utf8' }),
  ) as {
    source: {
      html: string;
      css: string;
      javascript: string;
      requestedCapabilities: string[];
    };
  };
  const sanitized = new ArtifactSanitizerV1().sanitize(draft.source);
  assert.match(sanitized.html, /data-sb-slide-deck="v1"/u);
  assert.deepEqual(draft.source.requestedCapabilities, []);
  assert.equal(sanitized.javascript, draft.source.javascript);
});
