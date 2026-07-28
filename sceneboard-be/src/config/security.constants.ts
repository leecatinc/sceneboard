import { Buffer } from 'node:buffer';

export const SECURITY_HKDF_SALT = Buffer.from('leecat-board/security/v1', 'ascii');

export const SECURITY_PURPOSES = [
  'session-token/v1',
  'grant-token/v1',
  'grant-list-cursor/v1',
  'csrf-anonymous/v1',
  'csrf-session/v1',
  'csrf-family-binding/v1',
  'auth-generation/v1',
  'pairing-locator/v1',
  'pairing-verifier/v1',
  'audit-email/v1',
  'audit-ip/v1',
  'audit-user-agent/v1',
  'audit-installation/v1',
  'email-verification-code/v1',
  'email-verification-ticket/v1',
  'board-invitation-token/v1',
  'share-password-pepper/v1',
  'share-password-attempt-link/v1',
  'share-password-attempt-ip/v1',
  'share-password-csrf/v1',
  'rate-limit-ip/v1',
  'rate-limit-email/v1',
  'rate-limit-user/v1',
  'rate-limit-session/v1',
  'rate-limit-pairing/v1',
  'rate-limit-grant/v1',
] as const;

export type SecurityPurpose = (typeof SECURITY_PURPOSES)[number];

export const SESSION_IDLE_LIFETIME_MS = 8 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const PAIRING_CODE_LIFETIME_MS = 5 * 60 * 1_000;
export const PAIRING_DECISION_LIFETIME_MS = 10 * 60 * 1_000;
export const PAIRING_REDEMPTION_LIFETIME_MS = 2 * 60 * 1_000;
export const PERSISTENT_GRANT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
export const BCRYPT_DUMMY_HASH = '$2b$12$abcdefghijklmnopqrstuuidLe3uuDOO6zbyQh4h5qkJX9iUOyj4K';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const encodeBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

export const decodeBase64UrlStrict = (
  value: string,
  options: { exactBytes?: number; minimumBytes?: number } = {},
): Buffer => {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value) || value.includes('=')) {
    throw new TypeError('value must be unpadded base64url');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (encodeBase64Url(decoded) !== value) throw new TypeError('value is not canonical base64url');
  if (options.exactBytes !== undefined && decoded.byteLength !== options.exactBytes) {
    throw new TypeError(`value must decode to exactly ${options.exactBytes} bytes`);
  }
  if (options.minimumBytes !== undefined && decoded.byteLength < options.minimumBytes) {
    throw new TypeError(`value must decode to at least ${options.minimumBytes} bytes`);
  }
  return decoded;
};
