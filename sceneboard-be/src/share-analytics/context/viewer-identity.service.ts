import { timingSafeEqual } from 'node:crypto';

import { decodeBase64UrlStrict } from '../../config/security.constants.js';
import type { CryptoService } from '../../common/security/crypto.service.js';
import { ShareAnalyticsError } from '../../common/errors/share-analytics.error.js';

const VIEWER_COOKIE = '__Host-sceneboard_viewer';
const CSRF_COOKIE = 'sceneboard_view_csrf';
const VIEWER_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

const cookies = (header: string | undefined): Map<string, string[]> => {
  const output = new Map<string, string[]>();
  if (header === undefined) return output;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  return output;
};

const singleton = (values: string[] | undefined): string | null =>
  values?.length === 1 ? values[0]! : null;

export interface ViewerIdentity {
  seed: Buffer;
  setCookie: string | null;
}

export class ViewerIdentityService {
  constructor(private readonly crypto: CryptoService) {}

  ensure(cookieHeader: string | undefined): ViewerIdentity {
    const current = singleton(cookies(cookieHeader).get(VIEWER_COOKIE));
    if (current !== null) {
      try {
        return { seed: decodeBase64UrlStrict(current, { exactBytes: 32 }), setCookie: null };
      } catch {
        // Invalid first-party state is replaced, never persisted or reflected.
      }
    }
    const token = this.crypto.randomBase64Url(32);
    return {
      seed: decodeBase64UrlStrict(token, { exactBytes: 32 }),
      setCookie: [
        `${VIEWER_COOKIE}=${token}`,
        `Max-Age=${VIEWER_MAX_AGE_SECONDS}`,
        'Path=/',
        'Secure',
        'HttpOnly',
        'SameSite=Lax',
      ].join('; '),
    };
  }

  require(cookieHeader: string | undefined): Buffer {
    const value = singleton(cookies(cookieHeader).get(VIEWER_COOKIE));
    if (value === null) throw new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE');
    try {
      return decodeBase64UrlStrict(value, { exactBytes: 32 });
    } catch {
      throw new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE');
    }
  }

  issueCsrf(input: { seed: Buffer; contextId: string; expiresAt: Date; now?: Date }): {
    token: string;
    setCookie: string;
  } {
    const expiresAt = String(input.expiresAt.valueOf());
    const nonce = this.crypto.randomBase64Url(16);
    const payload = `share-analytics-csrf/v1\0${input.contextId}\0${expiresAt}\0${nonce}\0${input.seed.toString('base64url')}`;
    const mac = this.crypto.hmac('share-analytics-csrf/v1', payload).toString('base64url');
    const token = `v1.${expiresAt}.${nonce}.${mac}`;
    return {
      token,
      setCookie: [
        `${CSRF_COOKIE}=${token}`,
        `Max-Age=${Math.max(
          1,
          Math.ceil((input.expiresAt.valueOf() - (input.now ?? new Date()).valueOf()) / 1_000),
        )}`,
        'Path=/api/v1/public/',
        'Secure',
        'SameSite=Lax',
      ].join('; '),
    };
  }

  newContextId(): string {
    return this.crypto.randomBase64Url(16);
  }

  assertCsrf(input: {
    cookieHeader: string | undefined;
    header: string | undefined;
    seed: Buffer;
    contextId: string;
    now: Date;
  }): void {
    const cookie = singleton(cookies(input.cookieHeader).get(CSRF_COOKIE));
    if (
      cookie === null ||
      input.header === undefined ||
      !this.sameAscii(cookie, input.header) ||
      !this.verifyCsrf(cookie, input.seed, input.contextId, input.now)
    )
      throw new ShareAnalyticsError('CSRF_INVALID');
  }

  derivatives(input: { seed: Buffer; contextId: string; utcDate: string }): {
    replayFamilyKey: Buffer;
    viewerDedupeKey: Buffer;
    viewerDailyKey: Buffer;
  } {
    const seed = input.seed.toString('base64url');
    return {
      replayFamilyKey: this.crypto.hmac(
        'share-analytics-replay-family/v1',
        `share-analytics-replay-family/v1\0${seed}\0${input.contextId}`,
      ),
      viewerDedupeKey: this.crypto.hmac(
        'share-analytics-dedupe-family/v1',
        `share-analytics-dedupe-family/v1\0${seed}`,
      ),
      viewerDailyKey: this.crypto.hmac(
        'share-analytics-daily/v1',
        `share-analytics-daily/v1\0${seed}\0${input.utcDate}`,
      ),
    };
  }

  private verifyCsrf(token: string, seed: Buffer, contextId: string, now: Date): boolean {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const expiresAt = parts[1]!;
    const nonce = parts[2]!;
    const mac = parts[3]!;
    if (!/^[1-9][0-9]{12}$/u.test(expiresAt) || Number(expiresAt) <= now.valueOf()) return false;
    try {
      decodeBase64UrlStrict(nonce, { exactBytes: 16 });
      const presented = decodeBase64UrlStrict(mac, { exactBytes: 32 });
      const payload = `share-analytics-csrf/v1\0${contextId}\0${expiresAt}\0${nonce}\0${seed.toString('base64url')}`;
      const expected = this.crypto.hmac('share-analytics-csrf/v1', payload);
      return timingSafeEqual(presented, expected);
    } catch {
      return false;
    }
  }

  private sameAscii(left: string, right: string): boolean {
    const a = Buffer.from(left, 'ascii');
    const b = Buffer.from(right, 'ascii');
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }
}

export const shareAnalyticsViewerCookieName = VIEWER_COOKIE;
export const shareAnalyticsCsrfCookieName = CSRF_COOKIE;
