import type { AppEnvironmentName } from '../config/env.schema.js';

interface CookieNames {
  session: string;
  csrf: string;
  secure: boolean;
}

const cookieNames = (environment: AppEnvironmentName): CookieNames => {
  if (environment === 'development')
    return { session: 'lcb_session', csrf: 'lcb_csrf', secure: false };
  if (environment === 'test')
    return { session: 'lcb_test_session', csrf: 'lcb_test_csrf', secure: false };
  return { session: '__Host-lcb_session', csrf: '__Host-lcb_csrf', secure: true };
};

const assertCookieValue = (value: string): void => {
  if (value === '' || /[\u0000-\u0020;,\u007f]/.test(value))
    throw new TypeError('cookie value is unsafe');
};

export class CookieService {
  readonly names: CookieNames;

  constructor(environment: AppEnvironmentName) {
    this.names = cookieNames(environment);
  }

  session(value: string, maximumAgeSeconds: number): string {
    assertCookieValue(value);
    return this.serialize(this.names.session, value, maximumAgeSeconds, true);
  }

  csrf(value: string, maximumAgeSeconds: number): string {
    assertCookieValue(value);
    return this.serialize(this.names.csrf, value, maximumAgeSeconds, false);
  }

  clear(): [string, string] {
    return [
      this.serialize(this.names.session, '', 0, true),
      this.serialize(this.names.csrf, '', 0, false),
    ];
  }

  private serialize(
    name: string,
    value: string,
    maximumAgeSeconds: number,
    httpOnly: boolean,
  ): string {
    if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 0)
      throw new TypeError('cookie Max-Age is invalid');
    const attributes = [`${name}=${value}`, `Max-Age=${maximumAgeSeconds}`, 'Path=/'];
    if (httpOnly) attributes.push('HttpOnly');
    if (this.names.secure) attributes.push('Secure');
    attributes.push('SameSite=Lax');
    return attributes.join('; ');
  }
}
