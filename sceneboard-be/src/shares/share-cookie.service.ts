import { createHash } from 'node:crypto';

import { CryptoService } from '../common/security/crypto.service.js';
import type { AppEnvironment } from '../config/env.schema.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';
import { ShareContractError } from '../common/errors/app-error.js';

export const SHARE_FAMILY_TTL_SECONDS = 1_800;
export const SHARE_CSRF_ROTATE_SECONDS = 900;

export interface ShareCookieProfile {
  familyName: '__Host-sceneboard_share' | 'sceneboard_share_dev';
  csrfName: 'sceneboard_share_csrf' | 'sceneboard_share_csrf_dev';
  secure: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const oneCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (cookieHeader === undefined || cookieHeader === '') return undefined;
  const values: string[] = [];
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() === name) values.push(entry.slice(separator + 1).trim());
  }
  if (values.length > 1) throw new ShareContractError('INVALID_REQUEST', null, 'csrf');
  return values[0];
};

const safeCookieValue = (value: string): void => {
  if (value === '' || /[\u0000-\u0020;,\u007f]/u.test(value)) {
    throw new TypeError('share cookie value is unsafe');
  }
};

export class ShareCookieService {
  constructor(
    private readonly environment: AppEnvironment,
    private readonly crypto: CryptoService,
  ) {}

  profile(hostname: string): ShareCookieProfile {
    const browser = new URL(this.environment.browserOrigin);
    if (browser.protocol === 'https:') {
      return {
        familyName: '__Host-sceneboard_share',
        csrfName: 'sceneboard_share_csrf',
        secure: true,
      };
    }
    if (this.environment.nodeEnv === 'production' || !LOOPBACK_HOSTS.has(hostname)) {
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    }
    return {
      familyName: 'sceneboard_share_dev',
      csrfName: 'sceneboard_share_csrf_dev',
      secure: false,
    };
  }

  familyFromHeader(cookieHeader: string | undefined, hostname: string): string | undefined {
    const profile = this.profile(hostname);
    const value = oneCookie(cookieHeader, profile.familyName);
    if (value === undefined) return undefined;
    try {
      decodeBase64UrlStrict(value, { exactBytes: 32 });
      return value;
    } catch {
      return undefined;
    }
  }

  csrfFromHeader(cookieHeader: string | undefined, hostname: string): string | undefined {
    return oneCookie(cookieHeader, this.profile(hostname).csrfName);
  }

  issueFamily(hostname: string): {
    token: string;
    digest: Buffer;
    setCookie: string;
  } {
    const token = this.crypto.randomBase64Url(32);
    return {
      token,
      digest: createHash('sha256').update(token, 'ascii').digest(),
      setCookie: this.serialize(this.profile(hostname), 'family', token, SHARE_FAMILY_TTL_SECONDS),
    };
  }

  familyDigest(token: string): Buffer {
    decodeBase64UrlStrict(token, { exactBytes: 32 });
    return createHash('sha256').update(token, 'ascii').digest();
  }

  ensureShareCsrfCookie(input: {
    hostname: string;
    cookieHeader?: string | undefined;
    nowSeconds: number;
  }): { csrfToken: string; setCookie: string | null } {
    const current = this.csrfFromHeader(input.cookieHeader, input.hostname);
    const verified = current === undefined ? null : this.verifyCsrf(current, input.nowSeconds);
    if (verified !== null && input.nowSeconds - verified.issuedAt < SHARE_CSRF_ROTATE_SECONDS) {
      return { csrfToken: current!, setCookie: null };
    }
    const token = this.issueCsrf(input.nowSeconds);
    return {
      csrfToken: token,
      setCookie: this.serialize(
        this.profile(input.hostname),
        'csrf',
        token,
        SHARE_FAMILY_TTL_SECONDS,
      ),
    };
  }

  assertCsrf(input: {
    hostname: string;
    cookieHeader?: string | undefined;
    header?: string | undefined;
    nowSeconds: number;
  }): void {
    const cookie = this.csrfFromHeader(input.cookieHeader, input.hostname);
    const header = input.header;
    if (
      cookie === undefined ||
      header === undefined ||
      this.verifyCsrf(cookie, input.nowSeconds) === null ||
      !this.crypto.constantTimeEqual(Buffer.from(cookie, 'ascii'), Buffer.from(header, 'ascii'))
    ) {
      throw new ShareContractError('INVALID_REQUEST', null, 'csrf');
    }
  }

  clearCsrf(hostname: string): string {
    return this.serialize(this.profile(hostname), 'csrf', '', 0);
  }

  clearFamily(hostname: string): string {
    return this.serialize(this.profile(hostname), 'family', '', 0);
  }

  private issueCsrf(issuedAt: number): string {
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) throw new TypeError('invalid CSRF clock');
    const random = this.crypto.randomBase64Url(32);
    const body = `v1|${issuedAt}|${random}`;
    const mac = encodeBase64Url(this.crypto.hmac('share-password-csrf/v1', body));
    return `v1.${issuedAt}.${random}.${mac}`;
  }

  private verifyCsrf(token: string, nowSeconds: number): { issuedAt: number } | null {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, issuedAtSource, random, macSource] = parts;
    if (
      issuedAtSource === undefined ||
      random === undefined ||
      macSource === undefined ||
      !/^[1-9][0-9]{0,12}$/u.test(issuedAtSource)
    ) {
      return null;
    }
    const issuedAt = Number(issuedAtSource);
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > nowSeconds ||
      nowSeconds - issuedAt >= SHARE_FAMILY_TTL_SECONDS
    ) {
      return null;
    }
    try {
      decodeBase64UrlStrict(random, { exactBytes: 32 });
      const mac = decodeBase64UrlStrict(macSource, { exactBytes: 32 });
      const expected = this.crypto.hmac('share-password-csrf/v1', `v1|${issuedAt}|${random}`);
      return this.crypto.constantTimeEqual(mac, expected) ? { issuedAt } : null;
    } catch {
      return null;
    }
  }

  private serialize(
    profile: ShareCookieProfile,
    kind: 'family' | 'csrf',
    value: string,
    maximumAgeSeconds: number,
  ): string {
    if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 0) {
      throw new TypeError('share cookie Max-Age is invalid');
    }
    if (value !== '') safeCookieValue(value);
    const name = kind === 'family' ? profile.familyName : profile.csrfName;
    const attributes = [`${name}=${value}`, `Max-Age=${maximumAgeSeconds}`, 'Path=/'];
    if (profile.secure) attributes.push('Secure');
    if (kind === 'family') attributes.push('HttpOnly');
    attributes.push('SameSite=Lax');
    return attributes.join('; ');
  }
}
