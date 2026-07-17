import { timingSafeEqual } from 'node:crypto';

import type { GrantId, PageCursorV1, TimestampV1 } from '@leecat-board/board-schema';

import {
  decodeSignedCursorV1,
  encodeSignedCursorV1,
  invalidCursorV1,
} from '../common/cursors/signed-cursor.js';
import {
  type CursorMacKeyV1,
  cursorHmacSha256V1,
} from '../common/security/cursor-mac-key.js';
import { encodeBase64Url } from '../config/security.constants.js';

const CONTEXT_DOMAIN = 'leecat-board.cursor-context.v1\0';
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type BoardListAccessContextV1 =
  | { accessKind: 'owner'; ownerUserId: string }
  | { accessKind: 'grant'; grantId: GrantId };

export interface BoardListCursorTupleV1 {
  createdAt: TimestampV1;
  boardPk: string;
}

const decimalId = (value: string): string => {
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_UNSIGNED_BIGINT) throw invalidCursorV1();
  return value;
};

const timestamp = (value: string): TimestampV1 => {
  const millis = Date.parse(value);
  if (!TIMESTAMP.test(value) || !Number.isSafeInteger(millis) || new Date(millis).toISOString() !== value) {
    throw invalidCursorV1();
  }
  return value as TimestampV1;
};

export class BoardListCursorCodec {
  constructor(private readonly key: CursorMacKeyV1) {}

  issue(input: {
    includeArchived: boolean;
    access: BoardListAccessContextV1;
    tuple: BoardListCursorTupleV1;
  }): PageCursorV1 {
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      k: 'boards',
      a: input.includeArchived,
      x: this.contextMac(input.access),
      t: timestamp(input.tuple.createdAt),
      p: decimalId(input.tuple.boardPk),
    }), 'utf8');
    return encodeSignedCursorV1(this.key, payload);
  }

  parse(input: {
    cursor: string;
    includeArchived: boolean;
    access: BoardListAccessContextV1;
  }): BoardListCursorTupleV1 {
    const { payload, decoded } = decodeSignedCursorV1(this.key, input.cursor);
    if (Object.keys(decoded).join(',') !== 'v,k,a,x,t,p'
      || decoded.v !== 1 || decoded.k !== 'boards'
      || decoded.a !== input.includeArchived
      || typeof decoded.x !== 'string' || typeof decoded.t !== 'string' || typeof decoded.p !== 'string') {
      throw invalidCursorV1();
    }
    const expectedContext = this.contextMac(input.access);
    const providedContext = Buffer.from(decoded.x, 'utf8');
    if (providedContext.byteLength !== expectedContext.length
      || !timingSafeEqual(providedContext, Buffer.from(expectedContext, 'utf8'))) {
      throw invalidCursorV1();
    }
    const tuple = { createdAt: timestamp(decoded.t), boardPk: decimalId(decoded.p) };
    const canonical = Buffer.from(JSON.stringify({
      v: 1, k: 'boards', a: input.includeArchived, x: expectedContext, t: tuple.createdAt, p: tuple.boardPk,
    }), 'utf8');
    if (!payload.equals(canonical)) throw invalidCursorV1();
    return tuple;
  }

  private contextMac(access: BoardListAccessContextV1): string {
    const payload = access.accessKind === 'owner'
      ? Buffer.from(JSON.stringify({ accessKind: 'owner', ownerUserId: decimalId(access.ownerUserId) }), 'utf8')
      : Buffer.from(JSON.stringify({ accessKind: 'grant', grantId: access.grantId }), 'utf8');
    return encodeBase64Url(cursorHmacSha256V1(this.key, CONTEXT_DOMAIN, payload));
  }
}
