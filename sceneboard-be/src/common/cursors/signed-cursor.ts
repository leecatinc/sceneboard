import { timingSafeEqual } from 'node:crypto';

import type { PageCursorV1 } from '@sceneboard/board-schema';

import { BoardContractError } from '../errors/app-error.js';
import { invalidBoardPayload } from '../errors/board-error.factory.js';
import { type CursorMacKeyV1, cursorHmacSha256V1 } from '../security/cursor-mac-key.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../../config/security.constants.js';
import { parseStrictJsonBytes } from '../http/strict-json.js';

const CURSOR_DOMAIN = 'leecat-board.cursor.v1\0';
const MAX_CURSOR_CHARS = 512;

export const invalidCursorV1 = (): BoardContractError =>
  new BoardContractError(invalidBoardPayload('invalid cursor'));

export const encodeSignedCursorV1 = (
  key: CursorMacKeyV1,
  canonicalPayload: Uint8Array,
): PageCursorV1 => {
  const cursor = encodeBase64Url(
    Buffer.concat([
      Buffer.from(canonicalPayload),
      cursorHmacSha256V1(key, CURSOR_DOMAIN, canonicalPayload),
    ]),
  );
  if (cursor.length < 1 || cursor.length > MAX_CURSOR_CHARS)
    throw new Error('cursor exceeds its wire limit');
  return cursor as PageCursorV1;
};

export const decodeSignedCursorV1 = (
  key: CursorMacKeyV1,
  cursor: string,
): {
  payload: Buffer;
  decoded: Record<string, unknown>;
} => {
  try {
    if (cursor.length < 1 || cursor.length > MAX_CURSOR_CHARS)
      throw new Error('invalid cursor length');
    const bytes = decodeBase64UrlStrict(cursor, { minimumBytes: 33 });
    const payload = bytes.subarray(0, bytes.byteLength - 32);
    const provided = bytes.subarray(bytes.byteLength - 32);
    const expected = cursorHmacSha256V1(key, CURSOR_DOMAIN, payload);
    if (!timingSafeEqual(provided, expected)) throw new Error('invalid cursor signature');
    const decoded = parseStrictJsonBytes(payload, { maximumBytes: 480, maximumDepth: 3 });
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('invalid cursor payload');
    }
    return { payload: Buffer.from(payload), decoded: decoded as Record<string, unknown> };
  } catch (error) {
    if (error instanceof BoardContractError) throw error;
    throw invalidCursorV1();
  }
};
