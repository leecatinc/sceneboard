import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertPublicArtifactEntitlement,
  assertPublicMediaEntitlement,
  type PublicArtifactEntitlement,
  type PublicMediaEntitlement,
} from '../../src/shares/public-resource-entitlement.js';
import { PublicShareHttpError } from '../../src/shares/public-share.error.js';

test('artifact delivery rejects structurally forged entitlement objects', () => {
  const forged = Object.freeze({
    kind: 'artifact',
    boardPk: 1n,
    sharePk: 1n,
    revisionPk: 1n,
    shareId: 'share_1',
    boardId: 'board_1',
    revisionId: 'revision_1',
    publicationGeneration: 1,
    accessGeneration: 1,
    contextId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    artifactId: 'artifact_1',
    versionId: 'version_1',
    referenceDigest: Buffer.alloc(32),
  }) as unknown as PublicArtifactEntitlement;
  assert.throws(
    () => assertPublicArtifactEntitlement(forged),
    (error) => error instanceof PublicShareHttpError && error.status === 503,
  );
});

test('media delivery rejects structurally forged entitlement objects', () => {
  const forged = Object.freeze({
    kind: 'media',
    boardPk: 1n,
    sharePk: 1n,
    revisionPk: 1n,
    shareId: 'share_1',
    boardId: 'board_1',
    revisionId: 'revision_1',
    publicationGeneration: 1,
    accessGeneration: 1,
    contextId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    mediaId: 'media_1',
    referenceDigest: Buffer.alloc(32),
  }) as unknown as PublicMediaEntitlement;
  assert.throws(
    () => assertPublicMediaEntitlement(forged),
    (error) => error instanceof PublicShareHttpError && error.status === 503,
  );
});

test('public entitlement path is context-bound and does not import account authorization', async () => {
  const source = await readFile(
    new URL('../../src/shares/public-resource-entitlement.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /contexts\.read/u);
  assert.match(source, /resolver\.withContext/u);
  assert.match(source, /canonicalizeJsonV1/u);
  assert.match(source, /authorizeArtifact/u);
  assert.match(source, /authorizeMedia/u);
  assert.doesNotMatch(source, /RequireBoardPrincipal|ActorContextService|authSession/u);
});
