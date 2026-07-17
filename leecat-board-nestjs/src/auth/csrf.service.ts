import { CryptoService } from '../common/security/crypto.service.js';
import { SESSION_IDLE_LIFETIME_MS, decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

const ANONYMOUS_CSRF_LIFETIME_MS = 10 * 60 * 1_000;

export interface IssuedCsrfToken {
  token: string;
  expiresAt: number;
}

type VerifyCsrfInput =
  | { kind: 'anonymous'; now: number }
  | { kind: 'session'; familyPublicId: string; now: number };

export class CsrfService {
  constructor(private readonly crypto: CryptoService) {}

  constantTimeEqual(left: string, right: string): boolean {
    return this.crypto.constantTimeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  }

  issueAnonymous(now: number): IssuedCsrfToken {
    return this.issue('a', '-', now + ANONYMOUS_CSRF_LIFETIME_MS);
  }

  issueSession(familyPublicId: string, now: number, sessionExpiry: number): IssuedCsrfToken {
    const binding = this.familyBinding(familyPublicId);
    return this.issue('s', binding, Math.min(now + SESSION_IDLE_LIFETIME_MS, sessionExpiry));
  }

  verify(token: string, input: VerifyCsrfInput): boolean {
    const verified = this.verifySignatureOnly(token, input.now);
    if (verified === null) return false;
    if (input.kind === 'anonymous') return verified.kind === 'a' && verified.binding === '-';
    return verified.kind === 's' && verified.binding === this.familyBinding(input.familyPublicId);
  }

  verifyAnySignature(token: string, now: number): boolean {
    return this.verifySignatureOnly(token, now) !== null;
  }

  private verifySignatureOnly(token: string, now: number): { kind: 'a' | 's'; binding: string } | null {
    const parts = token.split('.');
    if (parts.length !== 6 || parts[0] !== 'lcbcsrf_v1') return null;
    const [, kind, binding, nonce, expiresAtSource, macSource] = parts;
    if (kind !== 'a' && kind !== 's' || binding === undefined || nonce === undefined || expiresAtSource === undefined || macSource === undefined) return null;
    if (!/^[0-9]{13}$/.test(expiresAtSource)) return null;
    const expiresAt = Number(expiresAtSource);
    if (!Number.isSafeInteger(expiresAt) || now >= expiresAt) return null;
    try {
      if (kind === 'a' ? binding !== '-' : decodeBase64UrlStrict(binding, { exactBytes: 16 }).byteLength !== 16) return null;
      decodeBase64UrlStrict(nonce, { exactBytes: 16 });
      const mac = decodeBase64UrlStrict(macSource, { exactBytes: 32 });
      const expected = this.crypto.hmac(
        kind === 'a' ? 'csrf-anonymous/v1' : 'csrf-session/v1',
        `lcbcsrf_v1\0${kind}\0${binding}\0${nonce}\0${expiresAtSource}`,
      );
      return this.crypto.constantTimeEqual(mac, expected) ? { kind, binding } : null;
    } catch {
      return null;
    }
  }

  authGeneration(kind: 'a' | 's' | 'cleared', sessionPublicId: string | null, csrfToken: string | null): string {
    if (kind === 'cleared') return 'cleared';
    if (csrfToken === null) throw new TypeError('csrf token is required for a live auth generation');
    const input = `${kind}\0${sessionPublicId ?? '-'}\0${csrfToken}`;
    return encodeBase64Url(this.crypto.hmac('auth-generation/v1', input).subarray(0, 16));
  }

  private familyBinding(familyPublicId: string): string {
    return encodeBase64Url(this.crypto.hmac('csrf-family-binding/v1', familyPublicId).subarray(0, 16));
  }

  private issue(kind: 'a' | 's', binding: string, expiresAt: number): IssuedCsrfToken {
    if (!Number.isSafeInteger(expiresAt) || String(expiresAt).length !== 13) throw new TypeError('CSRF expiry must be a 13-digit epoch millisecond value');
    const nonce = this.crypto.randomBase64Url(16);
    const payload = `lcbcsrf_v1\0${kind}\0${binding}\0${nonce}\0${expiresAt}`;
    const purpose = kind === 'a' ? 'csrf-anonymous/v1' : 'csrf-session/v1';
    const mac = encodeBase64Url(this.crypto.hmac(purpose, payload));
    return { token: `lcbcsrf_v1.${kind}.${binding}.${nonce}.${expiresAt}.${mac}`, expiresAt };
  }
}
