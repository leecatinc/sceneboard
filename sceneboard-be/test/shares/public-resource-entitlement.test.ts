import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertPublicArtifactEntitlement,
  assertPublicMediaEntitlement,
  PublicResourceEntitlementService,
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

test('artifact-backed image projection grants the same bound public package entitlement', async () => {
  const contextId = 'A'.repeat(43);
  const familyDigest = Buffer.alloc(32, 4);
  const boardId = 'AAECAwQFBgcICQoLDA0ODw';
  const revisionId = '00112233-4455-4677-8899-aabbccddeeff';
  const connection = {};
  const resolved = {
    connection,
    boardId,
    share: {
      sharePk: 60n,
      shareId: 'share_1',
      boardPk: 50n,
      pinnedRevisionPk: 70n,
      pinnedRevisionId: revisionId,
      publicationGeneration: 1,
      accessGeneration: 1,
    },
  };
  const service = new PublicResourceEntitlementService(
    {
      read: async () => ({
        contextId,
        familyDigest,
        sharePk: 60n,
        boardPk: 50n,
        revisionPk: 70n,
        publicationGeneration: 1,
        accessGeneration: 1,
        validUntil: '2026-08-02T00:01:00.000Z',
        familyExpiresAt: '2026-08-02T00:30:00.000Z',
      }),
    } as never,
    { inspect: () => ({ kind: 'valid', token: 'token', digest: familyDigest }) } as never,
    { inspectFamilyHeader: () => ({ kind: 'absent' }) } as never,
    {
      withContext: async (input: { operation: (value: unknown) => Promise<unknown> }) =>
        input.operation(resolved),
    } as never,
    {
      build: async () => ({
        artifacts: [
          {
            artifactId: 'asset_1',
            versionId: 'version_1',
            status: 'ready',
            packageUrl: '/image-only-package',
          },
        ],
      }),
    } as never,
    'https://sceneboard.dev',
  );
  const result = await service.authorizeArtifact({
    shareId: 'share_1',
    revisionId,
    publicationGeneration: '1',
    accessGeneration: '1',
    artifactId: 'asset_1',
    versionId: 'version_1',
    contextId,
    cookieHeader: 'context=cookie',
    operation: async (authorizedConnection, entitlement) => {
      assert.equal(authorizedConnection, connection);
      assert.doesNotThrow(() => assertPublicArtifactEntitlement(entitlement));
      return `${entitlement.artifactId}:${entitlement.versionId}`;
    },
  });
  assert.equal(result, 'asset_1:version_1');
});
