import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { MediaMimeV1 } from '@sceneboard/board-schema';
import sharp from 'sharp';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';
import { MediaIngestionService } from '../../src/media/media-ingestion.service.js';
import type { CanonicalMediaV1 } from '../../src/media/media-repository.types.js';
import type { MediaRepository } from '../../src/media/media.repository.js';
import { MediaWriterGate } from '../../src/media/media-writer-gate.js';

const digests = { migration: 'm', projection: 'p', nativeManifest: 'n' };

const readyGate = (): MediaWriterGate => {
  const gate = new MediaWriterGate('2026-07-28T00:00:00.000Z', digests);
  gate.enable({
    revisionMediaRefsReady: true,
    mediaStoreProjectionReady: true,
    mediaRetentionRecoveryReady: true,
    mediaNativeDecoderReady: true,
    artifactDigests: digests,
    checkedAt: '2026-07-28T00:00:01.000Z',
  });
  return gate;
};

const principal = {
  kind: 'user',
  actor: {
    principalKind: 'user',
    principalId: 'account_1',
    grantId: null,
    scopes: [],
  },
  userPk: 1n,
  sessionPk: 2n,
  familyPublicId: 'family_1',
} as unknown as ResolvedBoardPrincipalV1;

const accessPolicy = {
  withAuthorizedBoardTransaction: async (
    _input: unknown,
    apply: (connection: unknown, context: unknown) => Promise<unknown>,
  ) =>
    apply(
      {},
      {
        ownerUserPk: 1n,
        accountUserPk: 1n,
        membership: { boardPk: 3n },
      },
    ),
};

const encoded = async (mime: MediaMimeV1): Promise<Buffer> => {
  const pipeline = sharp({
    create: {
      width: 20,
      height: 10,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.8 },
    },
  });
  if (mime === 'image/png') return pipeline.png().toBuffer();
  if (mime === 'image/jpeg') return pipeline.jpeg().toBuffer();
  return pipeline.webp().toBuffer();
};

const createHarness = () => {
  const captured: CanonicalMediaV1[] = [];
  const audits: unknown[] = [];
  const repository = {
    hasIdempotency: async () => false,
    ingest: async (input: { canonical: CanonicalMediaV1 }) => {
      captured.push(input.canonical);
      return {
        replayed: false,
        result: {
          protocolVersion: 1,
          type: 'media.ingest.result',
          requestId: 'request_media_1',
          status: 'created',
          media: {
            mediaId: 'media_1',
            sha256: input.canonical.sha256Hex,
            mime: input.canonical.mime,
            width: input.canonical.width,
            height: input.canonical.height,
            bytes: input.canonical.bytes.byteLength,
          },
        },
      };
    },
  };
  return {
    captured,
    audits,
    service: new MediaIngestionService(
      accessPolicy as never,
      repository as unknown as MediaRepository,
      readyGate(),
      {
        writeMandatory: async (_transaction: unknown, input: unknown) => {
          audits.push(input);
        },
      } as never,
    ),
  };
};

test('canonicalizes PNG, JPEG, and WebP into bounded metadata-free immutable bytes', async () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    const harness = createHarness();
    const body = await encoded(mime);
    const original = Buffer.from(body);
    const result = await harness.service.ingest({
      principal,
      boardId: 'board_1',
      requestId: 'request_media_1' as never,
      idempotencyKey: 'media-upload-key-0001',
      contentType: mime,
      contentLength: body.byteLength,
      contentDigest: `sha-256=:${createHash('sha256').update(body).digest('base64')}:`,
      body,
    });
    assert.equal(result.replayed, false);
    assert.equal(harness.captured.length, 1);
    assert.equal(harness.audits.length, 1);
    const canonical = harness.captured[0]!;
    assert.equal(canonical.mime, mime);
    assert.equal(canonical.width, 20);
    assert.equal(canonical.height, 10);
    assert.equal(canonical.bytes.byteLength <= 10_485_760, true);
    assert.deepEqual(canonical.sha256, createHash('sha256').update(canonical.bytes).digest());
    assert.equal(body.equals(Buffer.alloc(original.byteLength)), true);
    const metadata = await sharp(canonical.bytes).metadata();
    assert.equal(metadata.width, 20);
    assert.equal(metadata.height, 10);
  }
});

test('rejects hostile format bytes before persistence and fails closed while uncertified', async () => {
  const harness = createHarness();
  const hostile = Buffer.from('<svg><script>alert(1)</script></svg>');
  await assert.rejects(
    harness.service.ingest({
      principal,
      boardId: 'board_1',
      requestId: 'request_media_1' as never,
      idempotencyKey: 'media-upload-key-0001',
      contentType: 'image/png',
      contentLength: hostile.byteLength,
      contentDigest: `sha-256=:${createHash('sha256').update(hostile).digest('base64')}:`,
      body: hostile,
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'INVALID_MEDIA_UPLOAD' &&
      error.boardError.details.reason === 'format',
  );
  assert.equal(harness.captured.length, 0);

  const disabled = new MediaIngestionService(
    accessPolicy as never,
    {} as MediaRepository,
    new MediaWriterGate('2026-07-28T00:00:00.000Z', digests),
    { writeMandatory: async () => undefined } as never,
  );
  await assert.rejects(
    disabled.ingest({
      principal,
      boardId: 'board_1',
      requestId: 'request_media_1' as never,
      idempotencyKey: 'media-upload-key-0001',
      contentType: 'image/png',
      contentLength: 1,
      contentDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      body: Buffer.from([0]),
    }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'SERVICE_UNAVAILABLE',
  );
});
