import type { EventId, RevisionId, TimestampV1 } from '@sceneboard/board-schema';
import type { RowDataPacket } from 'mysql2/promise';

import type { SceneArtifactReferenceRowV1 } from './scene-artifact-reference.extractor.js';
import type { RevisionMediaReferenceRowV1 } from '../media/media-reference.types.js';
import type {
  DecodedBoardCheckpoint,
  EncodedBoardCheckpoint,
} from './document-checkpoint.codec.js';

export type SceneMutationTypeV1 =
  | 'scene.replace'
  | 'scene.clear'
  | 'scene.restore'
  | 'document.replace';

export interface MutationRuntime {
  now(): Date;
  generateUuid(): string;
}

export interface PreparedMutationV1 {
  revisionId: RevisionId;
  revisionIdBytes: Buffer;
  eventId: EventId;
  eventIdBytes: Buffer;
  recordIdBytes: Buffer;
  occurredAt: TimestampV1;
  occurredAtSql: string;
  expiresAtSql: string;
  fingerprintPayload: Buffer;
  fingerprintSha256: Buffer;
  actorScopesPayload: Buffer;
  actorScopesSha256: Buffer;
  commandPayloadSha256: Buffer;
  idempotencyScopeSha256: Buffer;
  checkpoint: EncodedBoardCheckpoint | null;
  references: readonly SceneArtifactReferenceRowV1[] | null;
  mediaReferences: readonly RevisionMediaReferenceRowV1[] | null;
}

export interface MutationIdempotencyRow extends RowDataPacket {
  statusCode: string;
  operationType: string;
  fingerprintSha256: Buffer;
  actorGrantId: string | null;
  actorScopesSha256: Buffer;
  expectedRevisionId: string | null;
  commandPayloadSha256: Buffer;
  resultPayload: Buffer | null;
  resultCanonicalBytes: number | null;
  resultSha256: Buffer | null;
  resultBoardPk: string | null;
  resultRevisionPk: string | null;
}

export interface LockedHeadRow extends RowDataPacket {
  boardPk: string;
  archivedAt: string | null;
  headRevisionPk: string;
  headRevisionId: Buffer;
  headRevisionNumber: string;
  lastEventSequence: string;
  sceneSchemaVersion: string;
}

export interface RestoreSourceRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
  revisionNumber: string;
  sceneSchemaVersion: string;
  sceneCodec: string;
  scenePayload: Buffer;
  sceneCanonicalBytes: number;
  sceneStoredBytes: number;
  sceneSha256: Buffer;
}

export interface StoredReferenceRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

export interface StoredMediaReferenceRow extends RowDataPacket {
  mediaId: Buffer;
  firstPageId: Buffer;
  ordinal: number;
}

export interface ReplayRelationRow extends RowDataPacket {
  boardId: string;
  revisionId: Buffer;
  eventId: Buffer;
}

export interface RestorePreparedV1 {
  row: RestoreSourceRow;
  checkpoint: EncodedBoardCheckpoint;
  decoded: DecodedBoardCheckpoint;
  references: readonly SceneArtifactReferenceRowV1[];
  mediaReferences: readonly RevisionMediaReferenceRowV1[];
}

export type CollisionKind = 'revision' | 'event' | 'record';

export class MutationIdentifierCollisionError extends Error {
  constructor(readonly kind: CollisionKind) {
    super(`mutation identifier collision: ${kind}`);
    this.name = 'MutationIdentifierCollisionError';
  }
}
