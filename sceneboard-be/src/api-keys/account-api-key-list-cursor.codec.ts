import { timingSafeEqual } from 'node:crypto';

import type { PageCursorV1 } from '@sceneboard/board-schema';

import { decodeSignedCursorV1, encodeSignedCursorV1 } from '../common/cursors/signed-cursor.js';
import { AppError } from '../common/errors/app-error.js';
import { type CursorMacKeyV1, cursorHmacSha256V1 } from '../common/security/cursor-mac-key.js';
import { encodeBase64Url } from '../config/security.constants.js';
import type { AccountApiKeyListBoundary } from './account-api-key.repository.js';

const CONTEXT_DOMAIN = 'sceneboard.api-key-list-cursor-context.v1\0';
const TTL_MS = 15 * 60 * 1_000;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const invalid = (): never => {
  throw new AppError('INVALID_PAYLOAD');
};

const decimalId = (value: string): string => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value) || BigInt(value) > MAX_UNSIGNED_BIGINT) invalid();
  return value;
};

const timestamp = (value: string): string => {
  if (!TIMESTAMP.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
};

export class AccountApiKeyListCursorCodec {
  constructor(private readonly key: CursorMacKeyV1) {}

  issue(input: {
    ownerUserPk: string;
    boundary: AccountApiKeyListBoundary;
    now: number;
  }): PageCursorV1 {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'account-api-keys',
        x: this.ownerContext(input.ownerUserPk),
        t: timestamp(input.boundary.createdAt),
        p: decimalId(input.boundary.id),
        e: new Date(input.now + TTL_MS).toISOString(),
      }),
      'utf8',
    );
    return encodeSignedCursorV1(this.key, payload);
  }

  parse(input: { cursor: string; ownerUserPk: string; now: number }): AccountApiKeyListBoundary {
    try {
      const { payload, decoded } = decodeSignedCursorV1(this.key, input.cursor);
      if (
        Object.keys(decoded).join(',') !== 'v,k,x,t,p,e' ||
        decoded.v !== 1 ||
        decoded.k !== 'account-api-keys' ||
        typeof decoded.x !== 'string' ||
        typeof decoded.t !== 'string' ||
        typeof decoded.p !== 'string' ||
        typeof decoded.e !== 'string'
      )
        invalid();
      const context = decoded.x as string;
      const createdAt = decoded.t as string;
      const apiKeyPk = decoded.p as string;
      const expiry = decoded.e as string;
      const expected = this.ownerContext(input.ownerUserPk);
      const provided = Buffer.from(context, 'utf8');
      if (
        provided.byteLength !== Buffer.byteLength(expected) ||
        !timingSafeEqual(provided, Buffer.from(expected, 'utf8'))
      )
        invalid();
      const boundary = { createdAt: timestamp(createdAt), id: decimalId(apiKeyPk) };
      const expiresAt = timestamp(expiry);
      if (Date.parse(expiresAt) <= input.now) invalid();
      const canonical = Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'account-api-keys',
          x: expected,
          t: boundary.createdAt,
          p: boundary.id,
          e: expiresAt,
        }),
        'utf8',
      );
      if (!payload.equals(canonical)) invalid();
      return boundary;
    } catch {
      throw new AppError('INVALID_PAYLOAD');
    }
  }

  private ownerContext(ownerUserPk: string): string {
    const payload = Buffer.from(JSON.stringify({ ownerUserPk: decimalId(ownerUserPk) }), 'utf8');
    return encodeBase64Url(cursorHmacSha256V1(this.key, CONTEXT_DOMAIN, payload));
  }
}
