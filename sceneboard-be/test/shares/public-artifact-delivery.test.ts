import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('public artifact route is separate from account artifact controllers', async () => {
  const source = await readFile(
    new URL('../../src/shares/public-artifact.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /:shareId\/revisions\/:revisionId\/g\/:publicationGeneration\/:accessGeneration\/artifacts\/:artifactId\/versions\/:versionId\/package/u,
  );
  assert.match(source, /rangeHeader/u);
  assert.match(source, /contextQuery/u);
  assert.doesNotMatch(source, /RequireBoardPrincipal|\bArtifactController\b|boardPrincipal/u);
});

test('payload read stays behind entitlement proof and range length certification', async () => {
  const source = await readFile(
    new URL('../../src/shares/public-artifact-delivery.service.ts', import.meta.url),
    'utf8',
  );
  const authorize = source.indexOf('authorizeArtifact');
  const metadata = source.indexOf('readVersion');
  const range = source.indexOf('new PublicShareHttpError(416');
  const bytes = source.lastIndexOf('readVersion');
  assert.equal(authorize >= 0 && metadata > authorize && range > metadata && bytes > range, true);
  assert.match(source, /assertPublicArtifactEntitlement/u);
});
