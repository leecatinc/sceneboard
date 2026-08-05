import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { BoardDocument, BoardId, RevisionId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
import { RevisionMediaReferenceExtractor } from '../../src/media/revision-media-reference.extractor.js';
import { PublicShareHttpError } from '../../src/shares/public-share.error.js';
import { PublicShareProjectionRepository } from '../../src/shares/public-share-projection.repository.js';
import type { ResolvedPublicShare } from '../../src/shares/public-share.resolver.js';

test('owns the eight exact owner share management paths and success statuses', async () => {
  const source = await readFile(
    new URL('../../src/shares/share.controller.ts', import.meta.url),
    'utf8',
  );
  for (const route of [
    "@Get(':boardId/shares')",
    "@Post(':boardId/shares')",
    "@Patch(':boardId/shares/:shareId')",
    "@Post(':boardId/shares/:shareId/rotate-link')",
    "@Delete(':boardId/shares/:shareId')",
    "@Post(':boardId/shares/:shareId/password')",
    "@Post(':boardId/shares/:shareId/password/regenerate')",
    "@Delete(':boardId/shares/:shareId/password')",
  ]) {
    assert.equal(source.includes(route), true, route);
  }
  assert.equal(source.includes('response.status(result.replayed ? 200 : 201)'), true);
  assert.equal((source.match(/@HttpCode\(200\)/gu) ?? []).length, 3);
  assert.equal(source.includes('@HttpCode(204)'), true);
  assert.equal((source.match(/@RequireCsrf\('session'\)/gu) ?? []).length, 7);
});

test('normalizes every hidden share management failure without 403 or 410', async () => {
  const source = await readFile(
    new URL('../../src/common/filters/http-error.filter.ts', import.meta.url),
    'utf8',
  );
  const shareStart = source.indexOf("if (isSharePath(request.url ?? ''))");
  const shareBranch = source.slice(
    shareStart,
    source.indexOf('if (exception instanceof BoardContractError)', shareStart),
  );
  assert.match(shareBranch, /new ShareContractError\('BOARD_NOT_FOUND'\)/u);
  assert.match(shareBranch, /new ShareContractError\('INVALID_REQUEST'\)/u);
  assert.match(shareBranch, /new ShareContractError\('RATE_LIMITED'/u);
  assert.doesNotMatch(shareBranch, /\b403\b|\b410\b/u);
});

test('uses dedicated share authorization and reports archived owner state as conflict', async () => {
  const service = await readFile(
    new URL('../../src/shares/share-publication.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /'share\.list'/u);
  assert.match(service, /'share\.publish'/u);
  assert.match(service, /'share\.update'/u);
  assert.match(service, /'share\.rotate'/u);
  assert.match(service, /'share\.revoke'/u);
  assert.doesNotMatch(service, /operation: 'membership\.(?:list|invite)'/u);
  assert.match(service, /assertBoardActive/u);
});

const publicBoardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const publicRevisionId = '00112233-4455-4677-8899-aabbccddeeff' as RevisionId;

const mixedArtifactDocument = (): BoardDocument =>
  ({
    schemaVersion: 2,
    defaultPageId: 'page_1',
    pages: [
      {
        pageId: 'page_1',
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'root_1',
            type: 'layout.split',
            direction: 'horizontal',
            gap: 0,
            children: [
              {
                node: {
                  id: 'artifact_1',
                  type: 'content.artifact',
                  artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                  fallbackText: 'fallback',
                },
                weight: 1,
              },
              {
                node: {
                  id: 'image_1',
                  type: 'content.image',
                  source: {
                    type: 'artifact.resource',
                    artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                    path: 'image.png',
                    sha256: 'a'.repeat(64),
                  },
                  alt: 'image',
                  fit: 'contain',
                },
                weight: 1,
              },
            ],
          },
        },
      },
      {
        pageId: 'page_2',
        title: '',
        displayMode: 'fit-page',
        scene: {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: 'image_2',
            type: 'content.image',
            source: {
              type: 'artifact.resource',
              artifact: { artifactId: 'asset_1', versionId: 'version_1' },
              path: 'image.png',
              sha256: 'a'.repeat(64),
            },
            alt: 'image',
            fit: 'contain',
          },
        },
      },
    ],
  }) as unknown as BoardDocument;

const binaryOrderedArtifactDocument = (): BoardDocument =>
  ({
    schemaVersion: 2,
    defaultPageId: 'page_1',
    pages: [
      ['B_asset', 'version_1'],
      ['a_asset', 'version_1'],
      ['same_asset', 'B_version'],
      ['same_asset', 'a_version'],
    ].map(([artifactId, versionId], index) => ({
      pageId: `page_${index + 1}`,
      title: '',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: {
          id: `artifact_${index + 1}`,
          type: 'content.artifact',
          artifact: { artifactId, versionId },
          fallbackText: 'fallback',
        },
      },
    })),
  }) as unknown as BoardDocument;

const publicProjectionFixture = async (
  referenceRows: readonly Record<string, unknown>[],
  document: BoardDocument = mixedArtifactDocument(),
): Promise<{
  repository: PublicShareProjectionRepository;
  resolved: ResolvedPublicShare;
  artifactReads: string[];
  sql: string[];
}> => {
  const checkpoints = new DocumentCheckpointCodec();
  const checkpoint = await checkpoints.encodeDocument(document);
  const artifactReads: string[] = [];
  const sql: string[] = [];
  const connection = {
    async execute(source: string): Promise<[unknown, unknown]> {
      const normalized = source.replace(/\s+/g, ' ').trim();
      sql.push(normalized);
      if (normalized.includes('FROM board_revisions r'))
        return [
          [
            {
              revisionPk: '70',
              revisionId: Buffer.from(publicRevisionId.replaceAll('-', ''), 'hex'),
              schemaVersion: checkpoint.schemaVersion,
              codec: checkpoint.codec,
              payload: checkpoint.payload,
              canonicalBytes: checkpoint.canonicalBytes,
              storedBytes: checkpoint.storedBytes,
              sha256: checkpoint.sha256,
            },
          ],
          [],
        ];
      if (normalized.includes('FROM board_revision_artifact_refs')) return [[...referenceRows], []];
      if (normalized.includes('FROM board_revision_media_refs')) return [[], []];
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const repository = new PublicShareProjectionRepository(
    checkpoints,
    {
      readVersion: async (
        _connection: PoolConnection,
        _boardId: string,
        artifact: { artifactId: string; versionId: string },
      ) => {
        artifactReads.push(`${artifact.artifactId}:${artifact.versionId}`);
        return {
          runtime: {
            artifact,
            status: 'ready',
            updatedAt: '2026-08-02T00:00:00.000Z',
            failure: null,
          },
        };
      },
    } as never,
    new RevisionMediaReferenceExtractor(),
    { read: async () => [] } as never,
  );
  const resolved = {
    connection,
    boardId: publicBoardId,
    title: 'Public board',
    nowSql: '2026-08-02 00:00:00.000',
    now: new Date('2026-08-02T00:00:00.000Z'),
    share: {
      sharePk: 60n,
      shareId: 'share_1',
      boardPk: 50n,
      status: 'active',
      accessPolicy: 'L',
      pinnedRevisionPk: 70n,
      pinnedRevisionId: publicRevisionId,
      publicationGeneration: 1,
      accessGeneration: 1,
      tokenDigest: Buffer.alloc(32),
      version: 1,
      createdAtSql: '2026-08-02 00:00:00.000',
      updatedAtSql: '2026-08-02 00:00:00.000',
      credential: null,
    },
  } as ResolvedPublicShare;
  return { repository, resolved, artifactReads, sql };
};

test('public projection validates mixed A/I occurrence rows and emits one package per pair', async () => {
  const value = await publicProjectionFixture([
    {
      artifactId: 'asset_1',
      versionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
    {
      artifactId: 'asset_1',
      versionId: 'version_1',
      referenceCode: 'I',
      occurrenceCount: 2,
    },
  ]);
  const projection = await value.repository.build(value.resolved, 'A'.repeat(43));
  assert.deepEqual(value.artifactReads, ['asset_1:version_1']);
  assert.deepEqual(
    projection.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      status: artifact.status,
    })),
    [{ artifactId: 'asset_1', versionId: 'version_1', status: 'ready' }],
  );
  const referenceSql = value.sql.find((source) =>
    source.includes('FROM board_revision_artifact_refs'),
  );
  assert.match(referenceSql ?? '', /reference_code AS referenceCode/u);
  assert.doesNotMatch(referenceSql ?? '', /reference_code = 'A'/u);
});

test('public projection accepts artifact rows in MySQL ascii_bin order', async () => {
  const rows = [
    ['B_asset', 'version_1'],
    ['a_asset', 'version_1'],
    ['same_asset', 'B_version'],
    ['same_asset', 'a_version'],
  ].map(([artifactId, versionId]) => ({
    artifactId,
    versionId,
    referenceCode: 'A',
    occurrenceCount: 1,
  }));
  const value = await publicProjectionFixture(rows, binaryOrderedArtifactDocument());

  const projection = await value.repository.build(value.resolved, 'A'.repeat(43));

  assert.equal(projection.artifacts.length, 4);
  assert.deepEqual(value.artifactReads, [
    'B_asset:version_1',
    'a_asset:version_1',
    'same_asset:B_version',
    'same_asset:a_version',
  ]);
});

test('public projection rejects missing, extra, stale, or miscounted reference rows', async () => {
  for (const rows of [
    [
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'A',
        occurrenceCount: 1,
      },
    ],
    [
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'A',
        occurrenceCount: 1,
      },
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'I',
        occurrenceCount: 1,
      },
    ],
    [
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'A',
        occurrenceCount: 1,
      },
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'I',
        occurrenceCount: 2,
      },
      {
        artifactId: 'asset_2',
        versionId: 'version_1',
        referenceCode: 'A',
        occurrenceCount: 1,
      },
    ],
    [
      {
        artifactId: 'asset_1',
        versionId: 'version_1',
        referenceCode: 'A',
        occurrenceCount: 1,
      },
      {
        artifactId: 'asset_1',
        versionId: 'stale_version',
        referenceCode: 'I',
        occurrenceCount: 2,
      },
    ],
  ]) {
    const value = await publicProjectionFixture(rows);
    await assert.rejects(
      value.repository.build(value.resolved, 'A'.repeat(43)),
      (error: unknown) => error instanceof PublicShareHttpError && error.status === 503,
    );
  }
});
