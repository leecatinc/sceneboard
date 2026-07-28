import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  BoardIdParserV1,
  type BoardId,
  type MediaMimeV1,
  type RequestId,
} from '@sceneboard/board-schema';
import sharp, { type Sharp } from 'sharp';

import { AuditRepository } from '../audit/audit.repository.js';
import { BoardContractError } from '../common/errors/app-error.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { BoardAccessPolicy } from '../grants/board-access.policy.js';
import {
  invalidMediaRequest,
  invalidMediaUpload,
  mediaBoardNotFound,
  mediaRateLimited,
  mediaServiceUnavailable,
} from './media-errors.js';
import type { CanonicalMediaV1, MediaIngestFingerprintV1 } from './media-repository.types.js';
import { MediaRepository } from './media.repository.js';
import { MediaWriterGate } from './media-writer-gate.js';

const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 40_000_000;
const MAX_CANONICAL_BYTES = 10_485_760;
const MAX_DECODE_RATIO = 200;
const MAX_ACTIVE_JOBS = 2;
const DEADLINE_MS = 10_000;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/u;

export type MediaIngestionInputV1 = Readonly<{
  principal: ResolvedBoardPrincipalV1;
  boardId: string;
  requestId: RequestId;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  contentLength: number;
  contentDigest: string;
  body: Buffer;
}>;

export type MediaIngestionOutputV1 = Awaited<ReturnType<MediaIngestionService['ingest']>>;

const asMime = (value: string | undefined): MediaMimeV1 => {
  if (value !== 'image/png' && value !== 'image/jpeg' && value !== 'image/webp')
    throw new BoardContractError(invalidMediaRequest('content_type'));
  return value;
};

const assertMagic = (bytes: Buffer, mime: MediaMimeV1): void => {
  const png =
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (
    (mime === 'image/png' && !png) ||
    (mime === 'image/jpeg' && !jpeg) ||
    (mime === 'image/webp' && !webp)
  )
    throw new BoardContractError(invalidMediaUpload('format'));
};

const canonicalize = async (
  input: Buffer,
  mime: MediaMimeV1,
  deadline: number,
): Promise<CanonicalMediaV1> => {
  assertMagic(input, mime);
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new BoardContractError(invalidMediaUpload('decode'));
  let pipeline: Sharp;
  try {
    pipeline = sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_PIXELS,
      pages: 1,
      animated: false,
      sequentialRead: true,
      autoOrient: true,
    });
  } catch {
    throw new BoardContractError(mediaServiceUnavailable());
  }
  pipeline.timeout({ seconds: Math.max(1, Math.ceil(remaining / 1_000)) });
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      const metadata = await pipeline.metadata();
      const width = metadata.width;
      const height = metadata.height;
      const pages = metadata.pages ?? 1;
      if (pages !== 1) throw new BoardContractError(invalidMediaUpload('animated'));
      if (
        width === undefined ||
        height === undefined ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION
      )
        throw new BoardContractError(invalidMediaUpload('dimensions'));
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS)
        throw new BoardContractError(invalidMediaUpload('pixels'));
      if ((pixels * 4) / input.byteLength > MAX_DECODE_RATIO)
        throw new BoardContractError(invalidMediaUpload('ratio'));
      let output = pipeline;
      if (mime === 'image/png')
        output = output.png({
          compressionLevel: 9,
          adaptiveFiltering: false,
          palette: false,
          progressive: false,
        });
      else if (mime === 'image/jpeg')
        output = output.jpeg({
          quality: 90,
          chromaSubsampling: '4:4:4',
          progressive: false,
          mozjpeg: false,
        });
      else
        output = output.webp({
          quality: 90,
          alphaQuality: 100,
          lossless: false,
          nearLossless: false,
          smartSubsample: false,
        });
      const bytes = await output.toBuffer();
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_CANONICAL_BYTES)
        throw new BoardContractError(invalidMediaUpload('canonical_size'));
      if (performance.now() >= deadline) throw new BoardContractError(invalidMediaUpload('decode'));
      const digest = createHash('sha256').update(bytes).digest();
      return {
        bytes,
        sha256: digest,
        sha256Hex: digest.toString('hex'),
        mime,
        width,
        height,
      };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        pipeline.destroy();
        reject(new BoardContractError(invalidMediaUpload('decode')));
      }, remaining);
    });
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error instanceof BoardContractError) throw error;
    throw new BoardContractError(invalidMediaUpload('decode'));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    pipeline.destroy();
  }
};

export class MediaIngestionService {
  private activeJobs = 0;

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly repository: MediaRepository,
    private readonly gate: MediaWriterGate,
    private readonly audit: AuditRepository,
  ) {}

  async ingest(input: MediaIngestionInputV1): Promise<{
    result: Awaited<ReturnType<MediaRepository['ingest']>>['result'];
    replayed: boolean;
  }> {
    const deadline = performance.now() + DEADLINE_MS;
    try {
      this.gate.assertUploadReady();
      const boardId = BoardIdParserV1.parse(input.boardId);
      if (!boardId.ok) throw new BoardContractError(mediaBoardNotFound());
      if (input.idempotencyKey === undefined || !IDEMPOTENCY_PATTERN.test(input.idempotencyKey))
        throw new BoardContractError(invalidMediaRequest('idempotency_key'));
      const mime = asMime(input.contentType);
      const fingerprint: MediaIngestFingerprintV1 = {
        contentType: mime,
        contentLength: input.contentLength,
        contentDigest: input.contentDigest,
      };
      const replay = await this.inAuthorizedTransaction(
        input,
        boardId.data.value,
        fingerprint,
        null,
      );
      if (replay !== null) return replay;
      const canonical = await this.decode(input.body, mime, deadline);
      const committed = await this.inAuthorizedTransaction(
        input,
        boardId.data.value,
        fingerprint,
        canonical,
      );
      if (committed === null) throw new BoardContractError(mediaServiceUnavailable());
      return committed;
    } finally {
      input.body.fill(0);
    }
  }

  private async decode(
    body: Buffer,
    mime: MediaMimeV1,
    deadline: number,
  ): Promise<CanonicalMediaV1> {
    if (this.activeJobs >= MAX_ACTIVE_JOBS) throw new BoardContractError(mediaRateLimited());
    this.activeJobs += 1;
    try {
      return await canonicalize(body, mime, deadline);
    } finally {
      this.activeJobs -= 1;
    }
  }

  private async inAuthorizedTransaction(
    input: MediaIngestionInputV1,
    boardId: BoardId,
    fingerprint: MediaIngestFingerprintV1,
    canonical: CanonicalMediaV1 | null,
  ) {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'media.upload',
        boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const accountPk = context.accountUserPk ?? context.ownerUserPk;
        const boardPk = context.membership?.boardPk;
        if (boardPk === undefined) throw new BoardContractError(mediaServiceUnavailable());
        if (canonical === null) {
          const exists = await this.repository.hasIdempotency(
            connection,
            accountPk,
            boardPk,
            input.idempotencyKey!,
          );
          if (!exists) return null;
        }
        const outcome = await this.repository.ingest({
          connection,
          accountPk,
          boardPk,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey!,
          fingerprint,
          canonical,
        });
        if (!outcome.replayed && canonical !== null) {
          await this.audit.writeMandatory(
            { connection },
            {
              event: 'media.ingested',
              actorPublicId: input.principal.actor.principalId,
              userPublicId:
                input.principal.actor.principalKind === 'user'
                  ? input.principal.actor.principalId
                  : null,
              sessionPublicId: null,
              clientPublicId:
                input.principal.actor.principalKind === 'mcp_client'
                  ? input.principal.actor.principalId
                  : null,
              grantPublicId: input.principal.actor.grantId,
              subjectFingerprint: canonical.sha256,
              metadata: {
                boardPk,
                actorKind: input.principal.actor.principalKind,
                mime: canonical.mime,
                bytes: canonical.bytes.byteLength,
                replayed: false,
                outcome: 'created',
              },
            },
          );
        }
        return outcome;
      },
    );
  }
}
