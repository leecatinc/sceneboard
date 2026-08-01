import { timingSafeEqual } from 'node:crypto';

import type { BoardId, GrantId, PageCursorV1, RevisionId } from '@sceneboard/board-schema';

import {
  decodeSignedCursorV1,
  encodeSignedCursorV1,
  invalidCursorV1,
} from '../common/cursors/signed-cursor.js';
import { type CursorMacKeyV1, cursorHmacSha256V1 } from '../common/security/cursor-mac-key.js';
import { encodeBase64Url } from '../config/security.constants.js';

const CONTEXT_DOMAIN = 'leecat-board.history-cursor-context.v1\0';
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HistoryCursorAccessContextV1 =
  | { accessKind: 'owner'; ownerUserId: string }
  | { accessKind: 'grant'; grantId: GrantId }
  | { accessKind: 'account_api_key'; ownerUserId: string; apiKeyId: string };

export type HistoryCursorContextV1 = Readonly<{
  boardId: BoardId;
  limit: number;
  access: HistoryCursorAccessContextV1;
  retentionBoundary: RevisionId;
}>;

export type HistoryCursorAnchorV1 = Readonly<{
  version: 3;
  kind: 'revision' | 'retained';
  value: number;
}>;

const decimalId = (value: string): string => {
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_UNSIGNED_BIGINT)
    throw invalidCursorV1();
  return value;
};

const pageLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidCursorV1();
  return value;
};

const retentionBoundary = (value: string): RevisionId => {
  if (!REVISION_ID.test(value)) throw invalidCursorV1();
  return value as RevisionId;
};

export class HistoryCursorCodec {
  constructor(private readonly key: CursorMacKeyV1) {}

  issue(input: HistoryCursorContextV1 & { beforeRevisionNumber: number }): PageCursorV1 {
    this.assertAnchor(input.beforeRevisionNumber);
    return encodeSignedCursorV1(
      this.key,
      Buffer.from(
        JSON.stringify({
          v: 3,
          k: 'history',
          b: input.boardId,
          l: pageLimit(input.limit),
          x: this.contextMac(input.access),
          g: retentionBoundary(input.retentionBoundary),
          a: 'revision',
          n: input.beforeRevisionNumber,
        }),
        'utf8',
      ),
    );
  }

  issueRetained(input: HistoryCursorContextV1 & { retainedOrder: number }): PageCursorV1 {
    this.assertAnchor(input.retainedOrder);
    return encodeSignedCursorV1(
      this.key,
      Buffer.from(
        JSON.stringify({
          v: 3,
          k: 'history',
          b: input.boardId,
          l: pageLimit(input.limit),
          x: this.contextMac(input.access),
          g: retentionBoundary(input.retentionBoundary),
          a: 'retained',
          o: input.retainedOrder,
        }),
        'utf8',
      ),
    );
  }

  parse(cursor: string, context: HistoryCursorContextV1): number {
    const anchor = this.parseAnchor(cursor, context);
    return anchor.value;
  }

  parseAnchor(cursor: string, context: HistoryCursorContextV1): HistoryCursorAnchorV1 {
    const { payload, decoded } = decodeSignedCursorV1(this.key, cursor);
    const revisionAnchor = Object.keys(decoded).join(',') === 'v,k,b,l,x,g,a,n';
    const retainedAnchor = Object.keys(decoded).join(',') === 'v,k,b,l,x,g,a,o';
    if (
      (!revisionAnchor && !retainedAnchor) ||
      decoded.v !== 3 ||
      decoded.k !== 'history' ||
      decoded.b !== context.boardId ||
      decoded.l !== pageLimit(context.limit) ||
      typeof decoded.x !== 'string' ||
      decoded.g !== retentionBoundary(context.retentionBoundary) ||
      decoded.a !== (revisionAnchor ? 'revision' : 'retained')
    )
      throw invalidCursorV1();
    const expectedContext = this.contextMac(context.access);
    const providedContext = Buffer.from(decoded.x, 'utf8');
    if (
      providedContext.byteLength !== expectedContext.length ||
      !timingSafeEqual(providedContext, Buffer.from(expectedContext, 'utf8'))
    )
      throw invalidCursorV1();
    const value = revisionAnchor ? decoded.n : decoded.o;
    if (typeof value !== 'number') throw invalidCursorV1();
    this.assertAnchor(value);
    const canonical = Buffer.from(
      JSON.stringify(
        revisionAnchor
          ? {
              v: 3,
              k: 'history',
              b: context.boardId,
              l: context.limit,
              x: expectedContext,
              g: context.retentionBoundary,
              a: 'revision',
              n: value,
            }
          : {
              v: 3,
              k: 'history',
              b: context.boardId,
              l: context.limit,
              x: expectedContext,
              g: context.retentionBoundary,
              a: 'retained',
              o: value,
            },
      ),
      'utf8',
    );
    if (!payload.equals(canonical)) throw invalidCursorV1();
    return { version: 3, kind: revisionAnchor ? 'revision' : 'retained', value };
  }

  private assertAnchor(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) throw invalidCursorV1();
  }

  private contextMac(access: HistoryCursorAccessContextV1): string {
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
