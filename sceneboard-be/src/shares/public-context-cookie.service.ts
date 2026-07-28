import { createHash } from 'node:crypto';

import type { AppEnvironment } from '../config/env.schema.js';
import { decodeBase64UrlStrict } from '../config/security.constants.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { PublicShareHttpError } from './public-share.error.js';

export const PUBLIC_CONTEXT_FAMILY_TTL_SECONDS = 1_800;

export interface PublicContextCookieProfile {
  name: '__Host-sceneboard_public_context' | 'sceneboard_public_context_dev';
  secure: boolean;
}

export type PublicContextCookieInspection =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; token: string; digest: Buffer };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export class PublicContextCookieService {
  constructor(
    private readonly environment: AppEnvironment,
    private readonly crypto: CryptoService,
  ) {}

  profile(hostname: string): PublicContextCookieProfile {
    const browser = new URL(this.environment.browserOrigin);
    if (browser.protocol === 'https:') {
      return { name: '__Host-sceneboard_public_context', secure: true };
    }
    if (this.environment.nodeEnv === 'production' || !LOOPBACK_HOSTS.has(hostname))
      throw new PublicShareHttpError(503);
    return { name: 'sceneboard_public_context_dev', secure: false };
  }

  inspect(cookieHeader: string | undefined, hostname: string): PublicContextCookieInspection {
    const name = this.profile(hostname).name;
    if (cookieHeader === undefined || cookieHeader === '') return { kind: 'absent' };
    const values: string[] = [];
    for (const entry of cookieHeader.split(';')) {
      const separator = entry.indexOf('=');
      if (separator < 1) continue;
      if (entry.slice(0, separator).trim() === name) values.push(entry.slice(separator + 1).trim());
    }
    if (values.length === 0) return { kind: 'absent' };
    if (values.length !== 1) return { kind: 'invalid' };
    const token = values[0]!;
    try {
      decodeBase64UrlStrict(token, { exactBytes: 32 });
    } catch {
      return { kind: 'invalid' };
    }
    return {
      kind: 'valid',
      token,
      digest: createHash('sha256').update(token, 'ascii').digest(),
    };
  }

  issue(hostname: string): { token: string; digest: Buffer; setCookie: string } {
    const token = this.crypto.randomBase64Url(32);
    return {
      token,
      digest: createHash('sha256').update(token, 'ascii').digest(),
      setCookie: this.serialize(hostname, token),
    };
  }

  newContextId(): string {
    return this.crypto.randomBase64Url(32);
  }

  private serialize(hostname: string, token: string): string {
    const profile = this.profile(hostname);
    const attributes = [
      `${profile.name}=${token}`,
      `Max-Age=${PUBLIC_CONTEXT_FAMILY_TTL_SECONDS}`,
      'Path=/',
    ];
    if (profile.secure) attributes.push('Secure');
    attributes.push('HttpOnly', 'SameSite=Lax');
    return attributes.join('; ');
  }
}
