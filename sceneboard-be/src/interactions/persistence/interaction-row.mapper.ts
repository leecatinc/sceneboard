import { createHash, timingSafeEqual } from 'node:crypto';

import {
  HitlInteractionParserV1,
  HitlRequestDefinitionParserV1,
  HitlResponseParserV1,
  type HitlInteractionV1,
  type HitlRequestDefinitionV1,
  type HitlResponseV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import { parseMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';

export interface InteractionRowV1 extends RowDataPacket {
  hitlPk: string;
  boardPk: string;
  hitlRequestId: string;
  definitionKind: string;
  definitionPayload: Buffer;
  definitionCanonicalBytes: number;
  definitionSha256: Buffer;
  stateCode: string;
  responseKind: string | null;
  responsePayload: Buffer | null;
  responseCanonicalBytes: number | null;
  responseSha256: Buffer | null;
  createdByKind: string;
  createdByPrincipalId: string;
  createdByGrantId: string | null;
  answeredByKind: string | null;
  answeredByPrincipalId: string | null;
  answeredByGrantId: string | null;
  terminalByKind: string | null;
  terminalByPrincipalId: string | null;
  terminalByGrantId: string | null;
  supersededByRequestId: string | null;
  createdRequestId: string;
  answeredRequestId: string | null;
  createdEventSequence: string;
  stateEventSequence: string;
  createdAt: string;
  expiresAt: string;
  stateUpdatedAt: string;
  answeredAt: string | null;
}

export type StoredInteractionV1 = {
  hitlPk: string;
  boardPk: string;
  interaction: HitlInteractionV1;
  createdByKind: 'U' | 'M';
  createdByPrincipalId: string;
  createdByGrantId: string | null;
  supersededByRequestId: string | null;
  createdEventSequence: number;
  stateEventSequence: number;
};

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

const equal = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const integer = (value: string, allowZero = false): number => {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,15})$/u : /^[1-9][0-9]{0,15}$/u;
  if (!pattern.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const definitionKind = (kind: HitlRequestDefinitionV1['kind']): string =>
  ({
    info: 'I',
    choice: 'H',
    form: 'F',
    confirmation: 'C',
  })[kind];

const responseKind = (kind: HitlResponseV1['kind']): string =>
  ({
    info: 'I',
    choice: 'H',
    form: 'F',
    confirmation: 'C',
  })[kind];

const state = (code: string): HitlInteractionV1['state'] => {
  if (code === 'O') return 'open';
  if (code === 'A') return 'answered';
  if (code === 'S') return 'superseded';
  if (code === 'E') return 'expired';
  if (code === 'C') return 'cancelled';
  throw new BoardPersistenceError('row_integrity');
};

const timestamp = (value: string): TimestampV1 =>
  parseMysqlTimestampUtc(value).toISOString() as TimestampV1;

const actorShape = (
  kind: string | null,
  principalId: string | null,
  grantId: string | null,
): boolean =>
  (kind === 'U' && principalId !== null && grantId === null) ||
  (kind === 'M' && principalId !== null && grantId !== null);

export const canonicalDefinitionV1 = (value: HitlRequestDefinitionV1): Buffer => {
  const parsed = HitlRequestDefinitionParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return Buffer.from(parsed.data.canonicalBytes);
};

export const canonicalResponseV1 = (value: HitlResponseV1): Buffer => {
  const parsed = HitlResponseParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return Buffer.from(parsed.data.canonicalBytes);
};

export const mapInteractionRowV1 = (row: InteractionRowV1): StoredInteractionV1 => {
  if (!/^[1-9][0-9]{0,19}$/u.test(row.hitlPk) || !/^[1-9][0-9]{0,19}$/u.test(row.boardPk)) {
    throw new BoardPersistenceError('row_integrity');
  }
  if (
    row.definitionCanonicalBytes !== row.definitionPayload.byteLength ||
    row.definitionSha256.byteLength !== 32 ||
    !equal(row.definitionSha256, digest(row.definitionPayload))
  ) {
    throw new BoardPersistenceError('row_integrity');
  }
  const parsedDefinition = HitlRequestDefinitionParserV1.parseBytes(row.definitionPayload);
  if (
    !parsedDefinition.ok ||
    definitionKind(parsedDefinition.data.value.kind) !== row.definitionKind
  ) {
    throw new BoardPersistenceError('row_integrity');
  }
  let response: HitlResponseV1 | null = null;
  if (row.responsePayload === null) {
    if (
      row.responseKind !== null ||
      row.responseCanonicalBytes !== null ||
      row.responseSha256 !== null
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
  } else {
    if (
      row.responseCanonicalBytes !== row.responsePayload.byteLength ||
      row.responseSha256 === null ||
      row.responseSha256.byteLength !== 32 ||
      !equal(row.responseSha256, digest(row.responsePayload))
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    const parsedResponse = HitlResponseParserV1.parseBytes(row.responsePayload);
    if (!parsedResponse.ok || responseKind(parsedResponse.data.value.kind) !== row.responseKind) {
      throw new BoardPersistenceError('row_integrity');
    }
    response = parsedResponse.data.value;
  }
  const currentState = state(row.stateCode);
  const createdEventSequence = integer(row.createdEventSequence);
  const stateEventSequence = integer(row.stateEventSequence);
  if (
    stateEventSequence < createdEventSequence ||
    !actorShape(row.createdByKind, row.createdByPrincipalId, row.createdByGrantId)
  )
    throw new BoardPersistenceError('row_integrity');
  if (currentState === 'open') {
    if (
      stateEventSequence !== createdEventSequence ||
      row.answeredByKind !== null ||
      row.answeredByPrincipalId !== null ||
      row.answeredByGrantId !== null ||
      row.terminalByKind !== null ||
      row.terminalByPrincipalId !== null ||
      row.terminalByGrantId !== null ||
      row.answeredRequestId !== null
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
  } else if (currentState === 'answered') {
    if (
      !actorShape(row.answeredByKind, row.answeredByPrincipalId, row.answeredByGrantId) ||
      row.terminalByKind !== null ||
      row.terminalByPrincipalId !== null ||
      row.terminalByGrantId !== null ||
      row.answeredRequestId === null ||
      stateEventSequence <= createdEventSequence
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
  } else if (currentState === 'expired') {
    if (
      row.terminalByKind !== 'S' ||
      row.terminalByPrincipalId !== 'hitl-expiry-v1' ||
      row.terminalByGrantId !== null ||
      row.answeredByKind !== null ||
      row.answeredByPrincipalId !== null ||
      row.answeredByGrantId !== null ||
      row.answeredRequestId !== null ||
      stateEventSequence <= createdEventSequence ||
      timestamp(row.stateUpdatedAt) !== timestamp(row.expiresAt)
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
  } else if (currentState === 'cancelled' || currentState === 'superseded') {
    if (!actorShape(row.terminalByKind, row.terminalByPrincipalId, row.terminalByGrantId)) {
      throw new BoardPersistenceError('row_integrity');
    }
    if (
      row.answeredByKind !== null ||
      row.answeredByPrincipalId !== null ||
      row.answeredByGrantId !== null ||
      row.answeredRequestId !== null ||
      stateEventSequence <= createdEventSequence
    )
      throw new BoardPersistenceError('row_integrity');
  }
  if ((currentState === 'superseded') !== (row.supersededByRequestId !== null)) {
    throw new BoardPersistenceError('row_integrity');
  }
  const parsed = HitlInteractionParserV1.parse({
    hitlRequestId: row.hitlRequestId,
    definition: parsedDefinition.data.value,
    state: currentState,
    createdAt: timestamp(row.createdAt),
    expiresAt: timestamp(row.expiresAt),
    stateUpdatedAt: timestamp(row.stateUpdatedAt),
    response,
    answeredAt: row.answeredAt === null ? null : timestamp(row.answeredAt),
  });
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return {
    hitlPk: row.hitlPk,
    boardPk: row.boardPk,
    interaction: parsed.data.value,
    createdByKind: row.createdByKind as 'U' | 'M',
    createdByPrincipalId: row.createdByPrincipalId,
    createdByGrantId: row.createdByGrantId,
    supersededByRequestId: row.supersededByRequestId,
    createdEventSequence,
    stateEventSequence,
  };
};
