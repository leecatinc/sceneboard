import type {
  MediaId,
  MediaIngestResultV1,
  MediaMimeV1,
  RequestId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

export type CanonicalMediaV1 = Readonly<{
  bytes: Buffer;
  sha256: Buffer;
  sha256Hex: string;
  mime: MediaMimeV1;
  width: number;
  height: number;
}>;

export type MediaIngestFingerprintV1 = Readonly<{
  contentType: MediaMimeV1;
  contentLength: number;
  contentDigest: string;
}>;

export type MediaIngestRepositoryInputV1 = Readonly<{
  connection: PoolConnection;
  accountPk: bigint;
  boardPk: bigint;
  requestId: RequestId;
  idempotencyKey: string;
  fingerprint: MediaIngestFingerprintV1;
  canonical: CanonicalMediaV1 | null;
}>;

export type MediaIngestRepositoryResultV1 = Readonly<{
  result: MediaIngestResultV1;
  replayed: boolean;
}>;

export type CanonicalMediaObjectV1 = Readonly<{
  mediaPk: bigint;
  sha256: Buffer;
  bytes: Buffer;
  mime: MediaMimeV1;
  width: number;
  height: number;
  byteLength: number;
  state: 'active' | 'quarantined';
  version: bigint;
}>;

export type LockedBoardMediaV1 = Readonly<{
  boardMediaPk: bigint;
  boardPk: bigint;
  mediaPk: bigint;
  mediaId: MediaId;
  status: 'active' | 'quarantined' | 'released';
  leaseExpiresAt: string;
  version: bigint;
}>;
