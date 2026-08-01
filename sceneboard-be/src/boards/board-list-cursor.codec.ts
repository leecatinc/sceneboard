import { timingSafeEqual } from 'node:crypto';

import {
  BoardIdParserV1,
  type BoardId,
  type GrantId,
  type PageCursorV1,
  type TimestampV1,
} from '@sceneboard/board-schema';

import {
  decodeSignedCursorV1,
  encodeSignedCursorV1,
  invalidCursorV1,
} from '../common/cursors/signed-cursor.js';
import { type CursorMacKeyV1, cursorHmacSha256V1 } from '../common/security/cursor-mac-key.js';
import { encodeBase64Url } from '../config/security.constants.js';

const CONTEXT_DOMAIN = 'leecat-board.cursor-context.v1\0';
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type BoardListAccessContextV1 =
  | { accessKind: 'owner'; ownerUserId: string }
  | { accessKind: 'grant'; grantId: GrantId }
  | { accessKind: 'account_api_key'; ownerUserId: string; apiKeyId: string };

export interface BoardListCursorTupleV1 {
  createdAt: TimestampV1;
  boardId: BoardId;
}

const decimalId = (value: string): string => {
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_UNSIGNED_BIGINT)
    throw invalidCursorV1();
  return value;
};

const timestamp = (value: string): TimestampV1 => {
  const millis = Date.parse(value);
  if (
    !TIMESTAMP.test(value) ||
    !Number.isSafeInteger(millis) ||
    new Date(millis).toISOString() !== value
  ) {
    throw invalidCursorV1();
  }
  return value as TimestampV1;
};

const pageLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidCursorV1();
  return value;
};

const boardId = (value: unknown): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw invalidCursorV1();
  return parsed.data.value;
};

export class BoardListCursorCodec {
  constructor(private readonly key: CursorMacKeyV1) {}

  issue(input: {
    limit: number;
    includeArchived: boolean;
    access: BoardListAccessContextV1;
    tuple: BoardListCursorTupleV1;
  }): PageCursorV1 {
    const payload = Buffer.from(
      JSON.stringify({
        v: 3,
        k: 'boards',
        l: pageLimit(input.limit),
        a: input.includeArchived,
        x: this.contextMac(input.access),
        t: timestamp(input.tuple.createdAt),
        b: boardId(input.tuple.boardId),
      }),
      'utf8',
    );
    return encodeSignedCursorV1(this.key, payload);
  }

  parse(input: {
    cursor: string;
    limit: number;
    includeArchived: boolean;
    access: BoardListAccessContextV1;
  }): BoardListCursorTupleV1 {
    const { payload, decoded } = decodeSignedCursorV1(this.key, input.cursor);
    if (
      Object.keys(decoded).join(',') !== 'v,k,l,a,x,t,b' ||
      decoded.v !== 3 ||
      decoded.k !== 'boards' ||
      decoded.l !== pageLimit(input.limit) ||
      decoded.a !== input.includeArchived ||
      typeof decoded.x !== 'string' ||
      typeof decoded.t !== 'string'
    ) {
      throw invalidCursorV1();
    }
    const expectedContext = this.contextMac(input.access);
    const providedContext = Buffer.from(decoded.x, 'utf8');
    if (
      providedContext.byteLength !== expectedContext.length ||
      !timingSafeEqual(providedContext, Buffer.from(expectedContext, 'utf8'))
    ) {
      throw invalidCursorV1();
    }
    const tuple = { createdAt: timestamp(decoded.t), boardId: boardId(decoded.b) };
    const canonical = Buffer.from(
      JSON.stringify({
        v: 3,
        k: 'boards',
        l: input.limit,
        a: input.includeArchived,
        x: expectedContext,
        t: tuple.createdAt,
        b: tuple.boardId,
      }),
      'utf8',
    );
    if (!payload.equals(canonical)) throw invalidCursorV1();
    return tuple;
  }

  private contextMac(access: BoardListAccessContextV1): string {
    const payload = Buffer.from(
      JSON.stringify(
        access.accessKind === 'owner'
          ? { accessKind: 'owner', ownerUserId: decimalId(access.ownerUserId) }
          : access.accessKind === 'grant'
            ? { accessKind: 'grant', grantId: access.grantId }
            : {
                accessKind: 'account_api_key',
                ownerUserId: decimalId(access.ownerUserId),
                apiKeyId: decimalId(access.apiKeyId),
              },
      ),
      'utf8',
    );
    return encodeBase64Url(cursorHmacSha256V1(this.key, CONTEXT_DOMAIN, payload));
  }
}
