import { createHash, timingSafeEqual } from 'node:crypto';
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
  type BrotliOptions,
} from 'node:zlib';

import {
  BoardDocumentParserV2,
  BoardDocumentParserV3,
  SceneParserV1,
  type BoardDocument,
  type SceneV1,
} from '@sceneboard/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export const CHECKPOINT_LIMITS = {
  '1.0.0': { canonicalBytes: 786_432, storedBytes: 800_000 },
  '2.0.0': { canonicalBytes: 20_971_520, storedBytes: 33_554_432 },
  '3.0.0': { canonicalBytes: 20_971_520, storedBytes: 33_554_432 },
} as const;

type CheckpointSchemaVersion = keyof typeof CHECKPOINT_LIMITS;

interface EncodedCheckpointBase<Version extends CheckpointSchemaVersion> {
  schemaVersion: Version;
  codec: 'B';
  payload: Buffer;
  canonicalPayload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

export type EncodedSceneCheckpoint = EncodedCheckpointBase<'1.0.0'>;
export type EncodedDocumentCheckpoint = EncodedCheckpointBase<'2.0.0'>;
export type EncodedDocumentCheckpointV3 = EncodedCheckpointBase<'3.0.0'>;
export type EncodedBoardCheckpoint =
  | EncodedSceneCheckpoint
  | EncodedDocumentCheckpoint
  | EncodedDocumentCheckpointV3;

export interface StoredBoardCheckpoint {
  schemaVersion: string;
  codec: string;
  payload: Buffer;
  canonicalPayload?: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

export type DecodedBoardCheckpoint =
  | { kind: 'scene'; scene: SceneV1; canonicalBytes: Buffer }
  | { kind: 'document'; document: BoardDocument; canonicalBytes: Buffer };

const compress = (input: Buffer, options: BrotliOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    brotliCompress(input, options, (error, output) =>
      error === null ? resolve(output) : reject(error),
    );
  });

const decompress = (input: Buffer, maximumBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    brotliDecompress(input, { maxOutputLength: maximumBytes }, (error, output) =>
      error === null ? resolve(output) : reject(error),
    );
  });

const digest = (input: Uint8Array): Buffer => createHash('sha256').update(input).digest();

const integrityFailure = (cause?: unknown): BoardPersistenceError =>
  new BoardPersistenceError('checkpoint_integrity', cause);

const isVersion = (value: string): value is CheckpointSchemaVersion =>
  value === '1.0.0' || value === '2.0.0' || value === '3.0.0';

export class DocumentCheckpointCodec {
  async encodeScene(input: unknown): Promise<EncodedSceneCheckpoint> {
    const parsed = SceneParserV1.parse(input);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    return this.encodeCanonical('1.0.0', Buffer.from(parsed.data.canonicalBytes));
  }

  async encodeDocument(input: unknown): Promise<EncodedDocumentCheckpoint> {
    const parsed = BoardDocumentParserV2.parse(input);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    return this.encodeCanonical('2.0.0', Buffer.from(parsed.data.canonicalBytes));
  }

  async encodeDocumentV3(input: unknown): Promise<EncodedDocumentCheckpointV3> {
    const parsed = BoardDocumentParserV3.parse(input);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    return this.encodeCanonical('3.0.0', Buffer.from(parsed.data.canonicalBytes));
  }

  async decode(input: StoredBoardCheckpoint): Promise<DecodedBoardCheckpoint> {
    if (
      !isVersion(input.schemaVersion) ||
      input.codec !== 'B' ||
      !Number.isSafeInteger(input.canonicalBytes) ||
      !Number.isSafeInteger(input.storedBytes)
    ) {
      throw integrityFailure();
    }
    const limits = CHECKPOINT_LIMITS[input.schemaVersion];
    if (
      input.canonicalBytes < 1 ||
      input.canonicalBytes > limits.canonicalBytes ||
      input.storedBytes < 1 ||
      input.storedBytes > limits.storedBytes ||
      input.payload.byteLength !== input.storedBytes ||
      input.sha256.byteLength !== 32
    ) {
      throw integrityFailure();
    }
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = await decompress(input.payload, limits.canonicalBytes);
    } catch (error) {
      throw integrityFailure(error);
    }
    if (
      canonicalBytes.byteLength !== input.canonicalBytes ||
      !timingSafeEqual(digest(canonicalBytes), input.sha256)
    ) {
      throw integrityFailure();
    }
    if (input.schemaVersion === '1.0.0') {
      const parsed = SceneParserV1.parseBytes(canonicalBytes);
      if (!parsed.ok || !Buffer.from(parsed.data.canonicalBytes).equals(canonicalBytes))
        throw integrityFailure();
      return { kind: 'scene', scene: parsed.data.value, canonicalBytes };
    }
    const parsed =
      input.schemaVersion === '3.0.0'
        ? BoardDocumentParserV3.parseBytes(canonicalBytes)
        : BoardDocumentParserV2.parseBytes(canonicalBytes);
    if (!parsed.ok || !Buffer.from(parsed.data.canonicalBytes).equals(canonicalBytes))
      throw integrityFailure();
    return { kind: 'document', document: parsed.data.value, canonicalBytes };
  }

  private async encodeCanonical<Version extends CheckpointSchemaVersion>(
    schemaVersion: Version,
    canonicalPayload: Buffer,
  ): Promise<EncodedCheckpointBase<Version>> {
    const limits = CHECKPOINT_LIMITS[schemaVersion];
    if (canonicalPayload.byteLength < 1 || canonicalPayload.byteLength > limits.canonicalBytes) {
      throw integrityFailure();
    }
    let payload: Buffer;
    try {
      payload = await compress(canonicalPayload, {
        params: {
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: canonicalPayload.byteLength,
        },
      });
    } catch (error) {
      throw integrityFailure(error);
    }
    if (payload.byteLength < 1 || payload.byteLength > limits.storedBytes) throw integrityFailure();
    return {
      schemaVersion,
      codec: 'B',
      payload,
      canonicalPayload,
      canonicalBytes: canonicalPayload.byteLength,
      storedBytes: payload.byteLength,
      sha256: digest(canonicalPayload),
    };
  }
}
