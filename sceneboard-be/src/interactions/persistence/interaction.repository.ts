import { createHash } from 'node:crypto';

import type {
  BoardId,
  HitlInteractionV1,
  HitlRequestDefinitionV1,
  HitlRequestId,
  HitlResponseV1,
  RequestId,
  TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import type { AuthorizedBoardContextV1 } from '../../grants/board-access.policy.js';
import type { LockedControlMutationHeadV1 } from '../../revisions/control-mutation.repository.js';
import {
  canonicalDefinitionV1,
  canonicalResponseV1,
  mapInteractionRowV1,
  type InteractionRowV1,
  type StoredInteractionV1,
} from './interaction-row.mapper.js';

export const INTERACTION_ROW_COLUMNS = `
  CAST(i.hitl_pk AS CHAR) AS hitlPk,
  CAST(i.board_pk AS CHAR) AS boardPk,
  i.hitl_request_id AS hitlRequestId,
  i.definition_kind AS definitionKind,
  i.definition_payload AS definitionPayload,
  i.definition_canonical_bytes AS definitionCanonicalBytes,
  i.definition_sha256 AS definitionSha256,
  i.state_code AS stateCode,
  i.response_kind AS responseKind,
  i.response_payload AS responsePayload,
  i.response_canonical_bytes AS responseCanonicalBytes,
  i.response_sha256 AS responseSha256,
  i.created_by_kind AS createdByKind,
  i.created_by_principal_id AS createdByPrincipalId,
  i.created_by_grant_id AS createdByGrantId,
  i.answered_by_kind AS answeredByKind,
  i.answered_by_principal_id AS answeredByPrincipalId,
  i.answered_by_grant_id AS answeredByGrantId,
  i.terminal_by_kind AS terminalByKind,
  i.terminal_by_principal_id AS terminalByPrincipalId,
  i.terminal_by_grant_id AS terminalByGrantId,
  i.superseded_by_request_id AS supersededByRequestId,
  i.created_request_id AS createdRequestId,
  i.answered_request_id AS answeredRequestId,
  CAST(i.created_event_sequence AS CHAR) AS createdEventSequence,
  CAST(i.state_event_sequence AS CHAR) AS stateEventSequence,
  i.created_at AS createdAt,
  i.expires_at AS expiresAt,
  i.state_updated_at AS stateUpdatedAt,
  i.answered_at AS answeredAt
`;

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

const kindCode = (kind: HitlRequestDefinitionV1['kind'] | HitlResponseV1['kind']): string =>
  ({
    info: 'I',
    choice: 'H',
    form: 'F',
    confirmation: 'C',
  })[kind];

const actorCode = (context: AuthorizedBoardContextV1): 'U' | 'M' =>
  context.actor.principalKind === 'user' ? 'U' : 'M';

const affectedOne = (result: ResultSetHeader): void => {
  if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
};

export const isDuplicateInteractionIdError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return candidate.errno === 1062 || candidate.code === 'ER_DUP_ENTRY';
};

interface DueInteractionRow extends RowDataPacket {
  boardId: string;
  hitlRequestId: string;
}

export class InteractionRepository {
  async findDueCandidates(
    connection: PoolConnection,
    nowSql: string,
    limit = 100,
  ): Promise<readonly { boardId: BoardId; hitlRequestId: HitlRequestId }[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BoardPersistenceError('capacity_exhausted');
    }
    const [rows] = await connection.execute<DueInteractionRow[]>(
      `
      SELECT b.public_id AS boardId, i.hitl_request_id AS hitlRequestId
      FROM board_hitl_interactions i
      JOIN boards b ON b.board_pk = i.board_pk
      WHERE i.state_code = 'O' AND i.expires_at <= ?
      ORDER BY i.expires_at ASC, i.hitl_pk ASC
      LIMIT ${limit}
    `,
      [nowSql],
    );
    return rows.map((row) => ({
      boardId: row.boardId as BoardId,
      hitlRequestId: row.hitlRequestId as HitlRequestId,
    }));
  }

  async create(
    connection: PoolConnection,
    input: {
      head: LockedControlMutationHeadV1;
      context: AuthorizedBoardContextV1;
      hitlRequestId: HitlRequestId;
      definition: HitlRequestDefinitionV1;
      requestId: RequestId;
      sequence: number;
      createdAt: TimestampV1;
      createdAtSql: string;
      expiresAt: TimestampV1;
      expiresAtSql: string;
    },
  ): Promise<HitlInteractionV1> {
    const definition = canonicalDefinitionV1(input.definition);
    const [result] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_hitl_interactions (
        board_pk, hitl_request_id, definition_kind, definition_payload,
        definition_canonical_bytes, definition_sha256, state_code,
        created_by_kind, created_by_principal_id, created_by_grant_id,
        created_request_id, created_event_sequence, state_event_sequence,
        created_at, expires_at, state_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'O', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        input.head.boardPk,
        input.hitlRequestId,
        kindCode(input.definition.kind),
        definition,
        definition.byteLength,
        digest(definition),
        actorCode(input.context),
        input.context.actor.principalId,
        input.context.actor.grantId,
        input.requestId,
        input.sequence,
        input.sequence,
        input.createdAtSql,
        input.expiresAtSql,
        input.createdAtSql,
      ],
    );
    affectedOne(result);
    return {
      hitlRequestId: input.hitlRequestId,
      definition: input.definition,
      state: 'open',
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      stateUpdatedAt: input.createdAt,
      response: null,
      answeredAt: null,
    };
  }

  async readByPublicId(
    connection: PoolConnection,
    boardId: BoardId,
    hitlRequestId: HitlRequestId,
  ): Promise<StoredInteractionV1 | null> {
    const [rows] = await connection.execute<InteractionRowV1[]>(
      `
      SELECT ${INTERACTION_ROW_COLUMNS}
      FROM board_hitl_interactions i
      JOIN boards b ON b.board_pk = i.board_pk
      WHERE b.public_id = ? AND i.hitl_request_id = ?
    `,
      [boardId, hitlRequestId],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new BoardPersistenceError('row_integrity');
    return mapInteractionRowV1(rows[0]);
  }

  async lockByBoardPk(
    connection: PoolConnection,
    boardPk: string,
    hitlRequestId: HitlRequestId,
  ): Promise<StoredInteractionV1 | null> {
    const [rows] = await connection.execute<InteractionRowV1[]>(
      `
      SELECT ${INTERACTION_ROW_COLUMNS}
      FROM board_hitl_interactions i
      WHERE i.board_pk = ? AND i.hitl_request_id = ?
      FOR UPDATE
    `,
      [boardPk, hitlRequestId],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new BoardPersistenceError('row_integrity');
    return mapInteractionRowV1(rows[0]);
  }

  async lockPairByBoardPk(
    connection: PoolConnection,
    boardPk: string,
    firstId: HitlRequestId,
    secondId: HitlRequestId,
  ): Promise<readonly StoredInteractionV1[]> {
    const [rows] = await connection.execute<InteractionRowV1[]>(
      `
      SELECT ${INTERACTION_ROW_COLUMNS}
      FROM board_hitl_interactions i
      WHERE i.board_pk = ? AND i.hitl_request_id IN (?, ?)
      ORDER BY i.hitl_pk ASC
      FOR UPDATE
    `,
      [boardPk, firstId, secondId],
    );
    if (rows.length > 2) throw new BoardPersistenceError('row_integrity');
    return rows.map(mapInteractionRowV1);
  }

  async answer(
    connection: PoolConnection,
    input: {
      stored: StoredInteractionV1;
      context: AuthorizedBoardContextV1;
      requestId: RequestId;
      response: HitlResponseV1;
      sequence: number;
      answeredAtSql: string;
    },
  ): Promise<void> {
    const response = canonicalResponseV1(input.response);
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_hitl_interactions
      SET state_code = 'A', response_kind = ?, response_payload = ?,
          response_canonical_bytes = ?, response_sha256 = ?,
          answered_by_kind = ?, answered_by_principal_id = ?, answered_by_grant_id = ?,
          answered_request_id = ?, state_event_sequence = ?,
          state_updated_at = ?, answered_at = ?
      WHERE hitl_pk = ? AND state_code = 'O' AND state_event_sequence = ?
    `,
      [
        kindCode(input.response.kind),
        response,
        response.byteLength,
        digest(response),
        actorCode(input.context),
        input.context.actor.principalId,
        input.context.actor.grantId,
        input.requestId,
        input.sequence,
        input.answeredAtSql,
        input.answeredAtSql,
        input.stored.hitlPk,
        input.stored.stateEventSequence,
      ],
    );
    affectedOne(result);
  }

  async expire(
    connection: PoolConnection,
    input: {
      stored: StoredInteractionV1;
      sequence: number;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_hitl_interactions
      SET state_code = 'E', terminal_by_kind = 'S',
          terminal_by_principal_id = 'hitl-expiry-v1', terminal_by_grant_id = NULL,
          state_event_sequence = ?, state_updated_at = expires_at
      WHERE hitl_pk = ? AND state_code = 'O' AND state_event_sequence = ?
    `,
      [input.sequence, input.stored.hitlPk, input.stored.stateEventSequence],
    );
    affectedOne(result);
  }

  async cancel(
    connection: PoolConnection,
    input: {
      stored: StoredInteractionV1;
      context: AuthorizedBoardContextV1;
      sequence: number;
      updatedAtSql: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_hitl_interactions
      SET state_code = 'C', terminal_by_kind = ?, terminal_by_principal_id = ?,
          terminal_by_grant_id = ?, state_event_sequence = ?, state_updated_at = ?
      WHERE hitl_pk = ? AND state_code = 'O' AND state_event_sequence = ?
    `,
      [
        actorCode(input.context),
        input.context.actor.principalId,
        input.context.actor.grantId,
        input.sequence,
        input.updatedAtSql,
        input.stored.hitlPk,
        input.stored.stateEventSequence,
      ],
    );
    affectedOne(result);
  }

  async supersede(
    connection: PoolConnection,
    input: {
      stored: StoredInteractionV1;
      successor: StoredInteractionV1;
      context: AuthorizedBoardContextV1;
      sequence: number;
      updatedAtSql: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_hitl_interactions
      SET state_code = 'S', terminal_by_kind = ?, terminal_by_principal_id = ?,
          terminal_by_grant_id = ?, superseded_by_request_id = ?,
          state_event_sequence = ?, state_updated_at = ?
      WHERE hitl_pk = ? AND state_code = 'O' AND state_event_sequence = ?
    `,
      [
        actorCode(input.context),
        input.context.actor.principalId,
        input.context.actor.grantId,
        input.successor.interaction.hitlRequestId,
        input.sequence,
        input.updatedAtSql,
        input.stored.hitlPk,
        input.stored.stateEventSequence,
      ],
    );
    affectedOne(result);
  }
}
