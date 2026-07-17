import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  canonicalizeJsonV1,
  type BoardEventEnvelopeV1,
  type HitlInteractionV1,
} from '@leecat-board/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import { formatPublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import { INTERACTION_ROW_COLUMNS } from './interaction.repository.js';
import { mapInteractionRowV1, type InteractionRowV1 } from './interaction-row.mapper.js';

export type InteractionIntegrityProbeModeV1 =
  | 'FULL_OFFLINE'
  | 'BOUNDED_RESTART'
  | 'RESUMABLE_AUDIT';

export type InteractionIntegrityProbeResultV1 = Readonly<{
  mode: InteractionIntegrityProbeModeV1;
  checked: number;
  complete: boolean;
  nextAfterHitlPk: string | null;
}>;

interface IntegrityProbeRowV1 extends InteractionRowV1 {
  boardId: string;
  headLastEventSequence: string;
  successorHitlPk: string | null;
  successorCreatedAt: string | null;
  createdEventId: Buffer;
  createdEventSequenceActual: string;
  createdEventType: string;
  createdEventRevisionPk: string | null;
  createdEventPayload: Buffer;
  createdEventCanonicalBytes: number;
  createdEventSha256: Buffer;
  stateEventId: Buffer;
  stateEventSequenceActual: string;
  stateEventType: string;
  stateEventRevisionPk: string | null;
  stateEventPayload: Buffer;
  stateEventCanonicalBytes: number;
  stateEventSha256: Buffer;
}

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => (
  left.byteLength === right.byteLength
  && timingSafeEqual(Buffer.from(left), Buffer.from(right))
);

const safeInteger = (value: string, allowZero = false): number => {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,15})$/u : /^[1-9][0-9]{0,15}$/u;
  if (!pattern.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean => {
  const leftCanonical = canonicalizeJsonV1(left);
  const rightCanonical = canonicalizeJsonV1(right);
  if (!leftCanonical.ok || !rightCanonical.ok) return false;
  return equalBytes(leftCanonical.data.canonicalBytes, rightCanonical.data.canonicalBytes);
};

const parseEvent = (input: {
  eventId: Buffer;
  sequence: string;
  eventType: string;
  revisionPk: string | null;
  payload: Buffer;
  canonicalBytes: number;
  sha256: Buffer;
  boardId: string;
}): BoardEventEnvelopeV1 => {
  if (input.eventId.byteLength !== 16
    || input.revisionPk !== null
    || input.eventType !== 'hitl.updated'
    || input.canonicalBytes !== input.payload.byteLength
    || input.sha256.byteLength !== 32
    || !equalBytes(input.sha256, digest(input.payload))) {
    throw new BoardPersistenceError('row_integrity');
  }
  const parsed = BoardEventEnvelopeParserV1.parseBytes(input.payload);
  const sequence = safeInteger(input.sequence);
  if (!parsed.ok
    || parsed.data.value.eventId !== formatPublicUuidV4(input.eventId)
    || parsed.data.value.boardId !== input.boardId
    || parsed.data.value.sequence !== sequence
    || parsed.data.value.revisionId !== null
    || parsed.data.value.data.type !== 'hitl.updated') {
    throw new BoardPersistenceError('row_integrity');
  }
  return parsed.data.value;
};

const createdProjection = (interaction: HitlInteractionV1): HitlInteractionV1 => ({
  hitlRequestId: interaction.hitlRequestId,
  definition: interaction.definition,
  state: 'open',
  createdAt: interaction.createdAt,
  expiresAt: interaction.expiresAt,
  stateUpdatedAt: interaction.createdAt,
  response: null,
  answeredAt: null,
});

const validateRow = (row: IntegrityProbeRowV1): void => {
  const stored = mapInteractionRowV1(row);
  const headSequence = safeInteger(row.headLastEventSequence, true);
  if (stored.stateEventSequence > headSequence) throw new BoardPersistenceError('row_integrity');
  const createdEvent = parseEvent({
    eventId: row.createdEventId,
    sequence: row.createdEventSequenceActual,
    eventType: row.createdEventType,
    revisionPk: row.createdEventRevisionPk,
    payload: row.createdEventPayload,
    canonicalBytes: row.createdEventCanonicalBytes,
    sha256: row.createdEventSha256,
    boardId: row.boardId,
  });
  const stateEvent = parseEvent({
    eventId: row.stateEventId,
    sequence: row.stateEventSequenceActual,
    eventType: row.stateEventType,
    revisionPk: row.stateEventRevisionPk,
    payload: row.stateEventPayload,
    canonicalBytes: row.stateEventCanonicalBytes,
    sha256: row.stateEventSha256,
    boardId: row.boardId,
  });
  if (createdEvent.sequence !== stored.createdEventSequence
    || stateEvent.sequence !== stored.stateEventSequence
    || createdEvent.data.type !== 'hitl.updated'
    || stateEvent.data.type !== 'hitl.updated'
    || !sameCanonicalValue(createdEvent.data.hitl, createdProjection(stored.interaction))
    || !sameCanonicalValue(stateEvent.data.hitl, stored.interaction)) {
    throw new BoardPersistenceError('row_integrity');
  }
  if (stored.createdEventSequence === stored.stateEventSequence
    && !equalBytes(row.createdEventId, row.stateEventId)) {
    throw new BoardPersistenceError('row_integrity');
  }
  if (stored.interaction.state === 'superseded') {
    if (row.successorHitlPk === null || row.successorCreatedAt === null
      || parseMysqlTimestampUtc(row.successorCreatedAt).valueOf()
        <= Date.parse(stored.interaction.createdAt)) {
      throw new BoardPersistenceError('row_integrity');
    }
  } else if (row.successorHitlPk !== null || row.successorCreatedAt !== null) {
    throw new BoardPersistenceError('row_integrity');
  }
};

export class InteractionIntegrityProbe {
  async inspectBatch(
    connection: PoolConnection,
    input: {
      mode: InteractionIntegrityProbeModeV1;
      afterHitlPk: string | null;
      limit: number;
    },
  ): Promise<InteractionIntegrityProbeResultV1> {
    const afterHitlPk = input.afterHitlPk ?? '0';
    safeInteger(afterHitlPk, true);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new BoardPersistenceError('capacity_exhausted');
    }
    const [rows] = await connection.execute<IntegrityProbeRowV1[]>(`
      SELECT ${INTERACTION_ROW_COLUMNS},
             b.public_id AS boardId,
             CAST(h.last_event_sequence AS CHAR) AS headLastEventSequence,
             CAST(successor.hitl_pk AS CHAR) AS successorHitlPk,
             successor.created_at AS successorCreatedAt,
             created_event.event_id AS createdEventId,
             CAST(created_event.sequence_number AS CHAR) AS createdEventSequenceActual,
             created_event.event_type AS createdEventType,
             CAST(created_event.revision_pk AS CHAR) AS createdEventRevisionPk,
             created_event.event_payload AS createdEventPayload,
             created_event.event_canonical_bytes AS createdEventCanonicalBytes,
             created_event.event_sha256 AS createdEventSha256,
             state_event.event_id AS stateEventId,
             CAST(state_event.sequence_number AS CHAR) AS stateEventSequenceActual,
             state_event.event_type AS stateEventType,
             CAST(state_event.revision_pk AS CHAR) AS stateEventRevisionPk,
             state_event.event_payload AS stateEventPayload,
             state_event.event_canonical_bytes AS stateEventCanonicalBytes,
             state_event.event_sha256 AS stateEventSha256
      FROM board_hitl_interactions i
      JOIN boards b ON b.board_pk = i.board_pk
      JOIN board_heads h ON h.board_pk = i.board_pk
      JOIN board_event_outbox created_event
        ON created_event.board_pk = i.board_pk
       AND created_event.sequence_number = i.created_event_sequence
      JOIN board_event_outbox state_event
        ON state_event.board_pk = i.board_pk
       AND state_event.sequence_number = i.state_event_sequence
      LEFT JOIN board_hitl_interactions successor
        ON successor.board_pk = i.board_pk
       AND successor.hitl_request_id = i.superseded_by_request_id
      WHERE i.hitl_pk > ?
      ORDER BY i.hitl_pk ASC
      LIMIT ${input.limit}
    `, [afterHitlPk]);
    for (const row of rows) validateRow(row);
    const last = rows.at(-1);
    return {
      mode: input.mode,
      checked: rows.length,
      complete: rows.length < input.limit,
      nextAfterHitlPk: last?.hitlPk ?? input.afterHitlPk,
    };
  }
}
