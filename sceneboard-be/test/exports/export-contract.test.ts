import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { BoardDocumentV3, BoardId, RevisionId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { EXPORT_FAILURE_DEFINITIONS_V1, ExportFailureV1 } from '../../src/exports/export-errors.js';
import { ExportAuthorizationPolicyV1 } from '../../src/exports/export-authorization.policy.js';
import { ExportGlobalAdmissionRepositoryV1 } from '../../src/exports/export-global-admission.repository.js';
import {
  canonicalizeExportProjectionV1,
  ExportProjectionServiceV1,
  type ExportProjectionResourceV1,
} from '../../src/exports/export-projection.service.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
import { ExportRenderSessionRepositoryV1 } from '../../src/exports/export-render-session.repository.js';
import { ExportRequestSchemaV1 } from '../../src/exports/export-request.schema.js';
import type { RedisService } from '../../src/redis/redis.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import type {
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';

const key = Buffer.alloc(32, 7);
const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA';
const token = 'BBBBBBBBBBBBBBBBBBBBBB';

test('export request and frozen failure catalog remain closed and exact', () => {
  assert.deepEqual(ExportRequestSchemaV1.parse({ format: 'pdf', revisionId: null }), {
    format: 'pdf',
    revisionId: null,
  });
  assert.deepEqual(ExportRequestSchemaV1.parse({ format: 'pptx', revisionId: 'revision_1' }), {
    format: 'pptx',
    revisionId: 'revision_1',
  });
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'pdf' }).success, false);
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'pdf', output: 'x' }).success, false);
  assert.equal(ExportRequestSchemaV1.safeParse({ format: 'svg' }).success, false);
  assert.deepEqual(Object.keys(EXPORT_FAILURE_DEFINITIONS_V1), [
    'EXPORT_INVALID_REQUEST',
    'EXPORT_UNAUTHENTICATED',
    'EXPORT_FORBIDDEN',
    'EXPORT_NOT_FOUND',
    'EXPORT_REQUIRED_CONTENT_UNSUPPORTED',
    'EXPORT_BOUNDS_EXCEEDED',
    'EXPORT_RATE_LIMITED',
    'EXPORT_RENDERER_UNAVAILABLE',
    'EXPORT_RENDER_TIMEOUT',
    'EXPORT_ENCODE_FAILED',
    'EXPORT_INTERNAL_ERROR',
  ]);
  const timeout = new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
  assert.deepEqual(
    { status: timeout.httpStatus, retryable: timeout.retryable },
    { status: 504, retryable: true },
  );
  assert.deepEqual(timeout.toPayload(), {
    ok: false,
    error: {
      code: 'EXPORT_RENDER_TIMEOUT',
      message: 'Export timed out',
      retryable: true,
    },
  });
});

test('export authorization preserves insufficient API-key scope as forbidden', async () => {
  const boards = {
    async withAuthorizedBoardTransaction() {
      throw new BoardContractError({
        protocolVersion: 1,
        type: 'board.error',
        code: 'FORBIDDEN',
        message: 'Forbidden',
        category: 'auth',
        retryable: false,
        httpStatusHint: 403,
        details: null,
      });
    },
  } as unknown as BoardAccessPolicy;
  const policy = new ExportAuthorizationPolicyV1(boards);
  const principal = {
    kind: 'account_api_key',
    actor: {
      principalKind: 'service',
      principalId: 'key_fixture',
      grantId: null,
      scopes: [],
    },
    ownerUserPk: 1n,
    apiKeyPk: 2n,
    scopeMask: 4,
    isBrowserCredential: false,
  } as unknown as ResolvedBoardPrincipalV1;
  await assert.rejects(
    policy.authorize({
      principal,
      boardId: 'board_fixture' as never,
      async apply() {
        throw new Error('authorization unexpectedly applied');
      },
    }),
    (error) => error instanceof ExportFailureV1 && error.code === 'EXPORT_FORBIDDEN',
  );
});

test('projection JSON canonicalization is deterministic across insertion order', () => {
  assert.equal(
    canonicalizeExportProjectionV1({ z: [3, { b: 2, a: 1 }], a: '한글' }),
    canonicalizeExportProjectionV1({ a: '한글', z: [3, { a: 1, b: 2 }] }),
  );
  assert.equal(
    canonicalizeExportProjectionV1({ z: [3, { b: 2, a: 1 }], a: '한글' }),
    '{"a":"한글","z":[3,{"a":1,"b":2}]}',
  );
});

test('render session uses the exact opaque key, HMAC binding, TTL and Lua protocol', async () => {
  const calls: Array<{
    script: string;
    keys: readonly string[];
    args: readonly string[];
  }> = [];
  const tokenHmac = createHmac('sha256', key).update(token, 'ascii').digest('hex');
  const redis = {
    async evaluate(script: string, keys: readonly string[], args: readonly string[]) {
      calls.push({ script, keys, args });
      if (script.includes("EXISTS', KEYS[1]")) return 1;
      if (args[0] === 'claim') return ['claimed', args[2]];
      if (args[0] === 'debit') return ['debited', '1', args[7]];
      if (args[0] === 'renew') return ['renewed'];
      if (args[0] === 'close') return ['closed'];
      if (args[0] === 'reject') return ['rejected'];
      if (script.includes("HGET', KEYS[1], 'tokenHmac")) return [tokenHmac];
      throw new Error('unexpected Redis call');
    },
  } as unknown as RedisService;
  const sessions = new ExportRenderSessionRepositoryV1(redis, key);
  await sessions.open({
    sessionId,
    token,
    boardPk: 1n,
    revisionPk: 2n,
    projectionSha256: 'a'.repeat(64),
    apiOrigin: 'http://127.0.0.1:3411',
    webOrigin: 'http://127.0.0.1:3410',
    openedAtMs: 1_000,
  });
  assert.equal(calls[0]?.keys[0], `sb:export-render:v1:{${sessionId}}:session`);
  assert.match(calls[0]?.script ?? '', /EXPIRE[^]*60/u);
  assert.equal(await sessions.authorizeToken(sessionId, token), true);
  assert.equal(await sessions.authorizeToken(sessionId, 'CCCCCCCCCCCCCCCCCCCCCC'), false);
  const claim = await sessions.claim({ sessionId, token, nowMs: 1_001 });
  assert.equal(typeof claim, 'string');
  assert.equal(
    await sessions.debitProjection({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_002,
      bytes: 1_048_576,
    }),
    true,
  );
  assert.equal(
    await sessions.debitResource({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_003,
      bytes: 268_435_456,
    }),
    true,
  );
  assert.equal(
    await sessions.renew({
      sessionId,
      claimNonce: claim ?? '',
      nowMs: 1_004,
    }),
    true,
  );
  await sessions.close({
    sessionId,
    claimNonce: claim ?? '',
    nowMs: 1_005,
  });
  const script = await readFile(
    new URL('../../src/exports/export-render-session-v1.lua', import.meta.url),
    'utf8',
  );
  assert.match(script, /state ~= 'open'/u);
  assert.match(script, /budget_exceeded/u);
  assert.match(script, /redis\.call\('DEL', KEYS\[1\]\)/u);
});

test('global export admission uses one expiring four-slot anonymous semaphore', async () => {
  const calls: Array<{ script: string; keys: readonly string[]; args: readonly string[] }> = [];
  const redis = {
    async evaluate(script: string, keys: readonly string[], args: readonly string[]) {
      calls.push({ script, keys, args });
      return 1;
    },
  } as unknown as RedisService;
  const admission = new ExportGlobalAdmissionRepositoryV1(redis);
  assert.equal(await admission.acquire(sessionId, 1_000), true);
  await admission.release(sessionId);
  assert.equal(calls[0]?.keys[0], 'sb:export-render:v1:global');
  assert.deepEqual(calls[0]?.args, ['1000', '181000', '4', sessionId]);
  assert.match(calls[0]?.script ?? '', /ZREMRANGEBYSCORE/u);
  assert.match(calls[0]?.script ?? '', /ZCARD/u);
  assert.match(calls[1]?.script ?? '', /ZREM/u);
  assert.doesNotMatch(
    calls.map(({ keys }) => keys.join(':')).join('\n'),
    /board|revision|api-key/u,
  );
});

const exportBoardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const exportRevisionId = '00112233-4455-4677-8899-aabbccddeeff' as RevisionId;

const exportDocument = (roots: readonly unknown[]): BoardDocumentV3 =>
  ({
    schemaVersion: 3,
    format: 'wide_16_9',
    defaultPageId: 'page_1',
    pages: roots.map((root, index) => ({
      pageId: `page_${index + 1}`,
      title: '',
      displayMode: 'fit-page',
      scene: { protocolVersion: 1, type: 'scene', root },
    })),
  }) as unknown as BoardDocumentV3;

const artifactNode = (id: string, type: 'A' | 'I') =>
  type === 'A'
    ? {
        id,
        type: 'content.artifact',
        artifact: { artifactId: 'asset_1', versionId: 'version_1' },
        fallbackText: '',
      }
    : {
        id,
        type: 'content.image',
        source: {
          type: 'artifact.resource',
          artifact: { artifactId: 'asset_1', versionId: 'version_1' },
          path: 'image.png',
          sha256: 'a'.repeat(64),
        },
        alt: '',
        fit: 'contain',
      };

const mediaNode = (id: string) => ({
  id,
  type: 'content.image',
  source: { type: 'media', mediaId: 'media_1' },
  alt: '',
  fit: 'contain',
});

const output = () => ({
  descriptors: new Map<string, ExportProjectionResourceV1>(),
  bytes: new Map<string, { mediaType: string; bytes: Buffer }>(),
});

const projectionConnection = (input: {
  mediaReferences?: readonly unknown[];
  mediaResources?: readonly unknown[];
  artifactReferences?: readonly unknown[];
}): PoolConnection =>
  ({
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.includes('FROM board_revision_artifact_refs'))
        return [input.artifactReferences ?? [], []];
      if (normalized.includes('JOIN board_media')) return [input.mediaResources ?? [], []];
      if (normalized.includes('FROM board_revision_media_refs'))
        return [input.mediaReferences ?? [], []];
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  }) as unknown as PoolConnection;

const projectionProbe = (packageReads: string[] = []) => {
  const service = new ExportProjectionServiceV1(
    new DocumentCheckpointCodec(),
    {
      readImmutablePackage: async (
        _connection: PoolConnection,
        _boardId: string,
        artifact: { artifactId: string; versionId: string },
      ) => {
        packageReads.push(`${artifact.artifactId}:${artifact.versionId}`);
        return { manifestBytes: Buffer.from('{}'), resources: [] };
      },
    } as never,
    {} as never,
    [],
  );
  return service as unknown as {
    addMediaResources(
      connection: PoolConnection,
      revisionPk: bigint,
      boardId: BoardId,
      document: BoardDocumentV3,
      revisionId: RevisionId,
      sessionId: string,
      output: unknown,
    ): Promise<void>;
    addArtifactResources(
      connection: PoolConnection,
      revisionPk: bigint,
      boardId: BoardId,
      document: BoardDocumentV3,
      revisionId: RevisionId,
      sessionId: string,
      output: unknown,
    ): Promise<void>;
  };
};

const requiredContentFailure = (error: unknown): boolean =>
  error instanceof ExportFailureV1 && error.code === 'EXPORT_REQUIRED_CONTENT_UNSUPPORTED';

test('export accepts empty derived inventories and deduplicates repeated media', async () => {
  const probe = projectionProbe();
  const empty = exportDocument([null]);
  const emptyOutput = output();
  const emptyConnection = projectionConnection({});
  await probe.addMediaResources(
    emptyConnection,
    1n,
    exportBoardId,
    empty,
    exportRevisionId,
    sessionId,
    emptyOutput,
  );
  await probe.addArtifactResources(
    emptyConnection,
    1n,
    exportBoardId,
    empty,
    exportRevisionId,
    sessionId,
    emptyOutput,
  );
  assert.equal(emptyOutput.descriptors.size, 0);

  const bytes = Buffer.from('image');
  const mediaId = Buffer.from('media_1', 'ascii');
  const repeated = exportDocument([mediaNode('media_node_1'), mediaNode('media_node_2')]);
  const repeatedOutput = output();
  await probe.addMediaResources(
    projectionConnection({
      mediaReferences: [{ mediaId, firstPageId: Buffer.from('page_1', 'ascii'), ordinal: 1 }],
      mediaResources: [
        {
          mediaId,
          ordinal: 1,
          mediaType: 'image/png',
          bytes,
          byteLength: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest(),
        },
      ],
    }),
    1n,
    exportBoardId,
    repeated,
    exportRevisionId,
    sessionId,
    repeatedOutput,
  );
  assert.deepEqual(
    [...repeatedOutput.descriptors.values()].map((descriptor) => descriptor.usage),
    [{ kind: 'media', mediaId: 'media_1' }],
  );
});

test('export fails closed for incomplete, inactive, malformed, or misordered media rows', async () => {
  const probe = projectionProbe();
  const document = exportDocument([mediaNode('media_node_1'), mediaNode('media_node_2')]);
  const bytes = Buffer.from('image');
  const exactReference = {
    mediaId: Buffer.from('media_1', 'ascii'),
    firstPageId: Buffer.from('page_1', 'ascii'),
    ordinal: 1,
  };
  const exactResource = {
    mediaId: Buffer.from('media_1', 'ascii'),
    ordinal: 1,
    mediaType: 'image/png',
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest(),
  };
  for (const scenario of [
    { name: 'missing', mediaReferences: [], mediaResources: [exactResource] },
    {
      name: 'extra',
      mediaReferences: [
        exactReference,
        {
          mediaId: Buffer.from('media_2', 'ascii'),
          firstPageId: Buffer.from('page_2', 'ascii'),
          ordinal: 2,
        },
      ],
      mediaResources: [exactResource],
    },
    {
      name: 'malformed identifier',
      mediaReferences: [{ ...exactReference, mediaId: Buffer.from([0xff]) }],
      mediaResources: [exactResource],
    },
    {
      name: 'wrong first page',
      mediaReferences: [{ ...exactReference, firstPageId: Buffer.from('page_2', 'ascii') }],
      mediaResources: [exactResource],
    },
    {
      name: 'wrong ordinal',
      mediaReferences: [{ ...exactReference, ordinal: 2 }],
      mediaResources: [exactResource],
    },
    {
      name: 'inactive or quarantined object',
      mediaReferences: [exactReference],
      mediaResources: [],
    },
    {
      name: 'malformed active content',
      mediaReferences: [exactReference],
      mediaResources: [{ ...exactResource, sha256: Buffer.alloc(31) }],
    },
  ]) {
    await assert.rejects(
      probe.addMediaResources(
        projectionConnection(scenario),
        1n,
        exportBoardId,
        document,
        exportRevisionId,
        sessionId,
        output(),
      ),
      requiredContentFailure,
      scenario.name,
    );
  }
});

test('export validates exact A/I occurrence rows before deduplicating one artifact package', async () => {
  const packageReads: string[] = [];
  const probe = projectionProbe(packageReads);
  const document = exportDocument([
    artifactNode('artifact_1', 'A'),
    artifactNode('image_1', 'I'),
    artifactNode('image_2', 'I'),
  ]);
  const artifactReferences = [
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'A',
      occurrenceCount: 1,
    },
    {
      artifactId: 'asset_1',
      artifactVersionId: 'version_1',
      referenceCode: 'I',
      occurrenceCount: 2,
    },
  ];
  const resources = output();
  await probe.addArtifactResources(
    projectionConnection({ artifactReferences }),
    1n,
    exportBoardId,
    document,
    exportRevisionId,
    sessionId,
    resources,
  );
  assert.deepEqual(packageReads, ['asset_1:version_1']);
  assert.deepEqual(
    [...resources.descriptors.values()].map((descriptor) => descriptor.usage),
    [{ kind: 'artifact', artifactId: 'asset_1', versionId: 'version_1' }],
  );
});

test('export fails closed for missing, extra, malformed, stale, or miscounted A/I rows', async () => {
  const packageReads: string[] = [];
  const probe = projectionProbe(packageReads);
  const document = exportDocument([artifactNode('artifact_1', 'A')]);
  const exact = {
    artifactId: 'asset_1',
    artifactVersionId: 'version_1',
    referenceCode: 'A',
    occurrenceCount: 1,
  };
  for (const scenario of [
    { name: 'missing', artifactReferences: [] },
    {
      name: 'extra',
      artifactReferences: [exact, { ...exact, artifactId: 'asset_2' }],
    },
    { name: 'malformed', artifactReferences: [{ ...exact, referenceCode: 'X' }] },
    { name: 'stale A/I code', artifactReferences: [{ ...exact, referenceCode: 'I' }] },
    { name: 'wrong occurrence', artifactReferences: [{ ...exact, occurrenceCount: 2 }] },
  ]) {
    await assert.rejects(
      probe.addArtifactResources(
        projectionConnection(scenario),
        1n,
        exportBoardId,
        document,
        exportRevisionId,
        sessionId,
        output(),
      ),
      requiredContentFailure,
      scenario.name,
    );
  }
  assert.deepEqual(packageReads, []);
});
