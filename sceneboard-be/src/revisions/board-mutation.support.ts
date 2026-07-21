import { createHash, timingSafeEqual } from 'node:crypto';

import {
  canonicalizeJsonV1,
  type EventId,
  type MutationRequestV1,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { ResultSetHeader } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4, parsePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import type { SceneArtifactReferenceRowV1 } from './scene-artifact-reference.extractor.js';
import type { SceneMutationTypeV1 } from './board-mutation.types.js';

export const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

export const digestEquals = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export const canonicalBytes = (value: unknown): Buffer => {
  const parsed = canonicalizeJsonV1(value);
  if (!parsed.ok) throw internalFailure();
  return Buffer.from(parsed.data.canonicalBytes);
};

export const internalFailure = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'INTERNAL_ERROR',
    message: 'Internal error',
    category: 'internal',
    retryable: false,
    httpStatusHint: 500,
    details: null,
  });

export const invalidMutation = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'INVALID_PAYLOAD',
    message: 'Invalid payload',
    category: 'validation',
    retryable: false,
    httpStatusHint: 400,
    details: { path: ['command', 'type'], issue: 'expected a scene mutation' },
  });

export const revisionNotFound = (revisionId: RevisionId): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'REVISION_NOT_FOUND',
    message: 'Revision not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: { revisionId },
  });

export const boardArchived = (request: MutationRequestV1, archivedAt: string): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_ALREADY_ARCHIVED',
    message: 'Board is already archived',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      boardId: request.boardId,
      archivedAt: parseMysqlTimestampUtc(archivedAt).toISOString() as TimestampV1,
    },
  });

export const revisionConflict = (
  request: MutationRequestV1,
  actualRevisionId: RevisionId,
  actualRevisionNumber: number,
): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'REVISION_CONFLICT',
    message: 'Revision conflict',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      boardId: request.boardId,
      expectedRevisionId: request.expectedRevisionId,
      actualRevisionId,
      actualRevisionNumber,
      recovery: 'fetch_latest_then_retry',
    },
  });

export const idempotencyReuse = (
  request: MutationRequestV1,
  reason: 'grant_changed' | 'scopes_changed' | 'expected_revision_changed' | 'payload_changed',
): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'Idempotency key was reused for a different operation',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      scope: 'board.mutation',
      boardId: request.boardId,
      operationType: request.command.type,
      reason,
    },
  });

export const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || !Number.isSafeInteger(result.insertId) || result.insertId < 1) {
    throw internalFailure();
  }
  return BigInt(result.insertId);
};

export const actorCode = (
  kind: AuthorizedBoardContextV1['actor']['principalKind'],
): 'U' | 'M' | 'S' => {
  if (kind === 'user') return 'U';
  if (kind === 'mcp_client') return 'M';
  return 'S';
};

export const safePositive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

export const uuidBytesOrNull = (value: string): Buffer | null => {
  try {
    return Buffer.from(parsePublicUuidV4(value));
  } catch {
    return null;
  }
};

export const revisionIdFromBytes = (value: Uint8Array): RevisionId =>
  formatPublicUuidV4(value) as RevisionId;

export const eventIdFromBytes = (value: Uint8Array): EventId =>
  formatPublicUuidV4(value) as EventId;

export const isDuplicate = (error: unknown, constraint: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    errno?: unknown;
    code?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  if (candidate.errno !== 1062 && candidate.code !== 'ER_DUP_ENTRY') return false;
  return `${candidate.sqlMessage ?? candidate.message ?? ''}`.includes(constraint);
};

export const referenceRowsEqual = (
  left: readonly SceneArtifactReferenceRowV1[],
  right: readonly SceneArtifactReferenceRowV1[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const isSceneMutation = (value: string): value is SceneMutationTypeV1 =>
  value === 'scene.replace' || value === 'scene.clear' || value === 'scene.restore';
