import { createHash, timingSafeEqual } from 'node:crypto';
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
  type BrotliOptions,
} from 'node:zlib';

import { SceneParserV1, type SceneV1 } from '@leecat-board/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

const MAX_CANONICAL_BYTES = 786_432;
const MAX_STORED_BYTES = 800_000;

export interface EncodedSceneCheckpointV1 {
  schemaVersion: '1.0.0';
  codec: 'B';
  payload: Buffer;
  canonicalPayload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

export type StoredSceneCheckpointV1 = Omit<EncodedSceneCheckpointV1, 'canonicalPayload'> & {
  canonicalPayload?: Buffer;
};

const compress = (input: Buffer, options: BrotliOptions): Promise<Buffer> => new Promise((resolve, reject) => {
  brotliCompress(input, options, (error, output) => error === null ? resolve(output) : reject(error));
});

const decompress = (input: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  brotliDecompress(input, { maxOutputLength: MAX_CANONICAL_BYTES }, (error, output) => (
    error === null ? resolve(output) : reject(error)
  ));
});

const digest = (input: Uint8Array): Buffer => createHash('sha256').update(input).digest();

const integrityFailure = (cause?: unknown): BoardPersistenceError => new BoardPersistenceError('checkpoint_integrity', cause);

export class SceneCheckpointCodec {
  async encode(input: unknown): Promise<EncodedSceneCheckpointV1> {
    const parsed = SceneParserV1.parse(input);
    if (!parsed.ok) throw integrityFailure();
    const canonicalPayload = Buffer.from(parsed.data.canonicalBytes);
    if (canonicalPayload.byteLength < 1 || canonicalPayload.byteLength > MAX_CANONICAL_BYTES) throw integrityFailure();
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
    if (payload.byteLength < 1 || payload.byteLength > MAX_STORED_BYTES) throw integrityFailure();
    return {
      schemaVersion: '1.0.0',
      codec: 'B',
      payload,
      canonicalPayload,
      canonicalBytes: canonicalPayload.byteLength,
      storedBytes: payload.byteLength,
      sha256: digest(canonicalPayload),
    };
  }

  async decode(input: StoredSceneCheckpointV1): Promise<{ scene: SceneV1; canonicalBytes: Buffer }> {
    if (input.schemaVersion !== '1.0.0' || input.codec !== 'B'
      || input.canonicalBytes < 1 || input.canonicalBytes > MAX_CANONICAL_BYTES
      || input.storedBytes < 1 || input.storedBytes > MAX_STORED_BYTES
      || input.payload.byteLength !== input.storedBytes || input.sha256.byteLength !== 32) {
      throw integrityFailure();
    }
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = await decompress(input.payload);
    } catch (error) {
      throw integrityFailure(error);
    }
    if (canonicalBytes.byteLength !== input.canonicalBytes) throw integrityFailure();
    const actualDigest = digest(canonicalBytes);
    if (!timingSafeEqual(actualDigest, input.sha256)) throw integrityFailure();
    const parsed = SceneParserV1.parseBytes(canonicalBytes);
    if (!parsed.ok || !Buffer.from(parsed.data.canonicalBytes).equals(canonicalBytes)) throw integrityFailure();
    return { scene: parsed.data.value, canonicalBytes };
  }
}
