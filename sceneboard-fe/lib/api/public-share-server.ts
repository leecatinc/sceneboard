import 'server-only';

import {
  PublicShareTokenParserV1,
  ShareErrorEnvelopeParserV1,
  SharePasswordAdmissionRequestParserV1,
} from '@sceneboard/board-schema';

import {
  decodePublicShareBootstrapResponse,
  type PublicShareClientState,
} from './public-share-contract';

interface PublicShareServerOptions {
  apiOrigin: string;
  browserOrigin: string;
  nodeEnv: 'development' | 'test' | 'production';
  shareToken: string;
  cookieHeader?: string | undefined;
  fetcher?: typeof fetch | undefined;
}

interface PublicSharePasswordServerOptions extends PublicShareServerOptions {
  csrfToken: string;
  password: string;
}

export interface PublicShareServerResult {
  state: PublicShareClientState;
  setCookies: readonly string[];
}

export type PublicSharePasswordServerResult =
  | { kind: 'accepted'; setCookies: readonly string[] }
  | { kind: 'invalid'; reason: 'body' | 'csrf'; setCookies: readonly string[] }
  | { kind: 'not-admitted'; setCookies: readonly [] }
  | { kind: 'rate-limited'; retryAfterSeconds: number; setCookies: readonly [] }
  | { kind: 'unavailable'; setCookies: readonly [] };

type PublicSharePasswordOutcome =
  | { kind: 'accepted' }
  | { kind: 'invalid'; reason: 'body' | 'csrf' }
  | { kind: 'not-admitted' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

interface CookieProfile {
  context: string;
  family: string;
  csrf: string;
  secure: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const profile = (
  browserOrigin: string,
  nodeEnv: PublicShareServerOptions['nodeEnv'],
): CookieProfile => {
  const browser = new URL(browserOrigin);
  if (browser.protocol === 'https:')
    return {
      context: '__Host-sceneboard_public_context',
      family: '__Host-sceneboard_share',
      csrf: 'sceneboard_share_csrf',
      secure: true,
    };
  if (nodeEnv === 'production' || !LOOPBACK_HOSTS.has(browser.hostname))
    throw new TypeError('public share cookie profile is unavailable');
  return {
    context: 'sceneboard_public_context_dev',
    family: 'sceneboard_share_dev',
    csrf: 'sceneboard_share_csrf_dev',
    secure: false,
  };
};

const selectedCookiePresent = (header: string | undefined, name: string): boolean =>
  (header ?? '').split(';').some((entry) => entry.slice(0, entry.indexOf('=')).trim() === name);

const setCookieValues = (headers: Headers): string[] => {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const singleton = headers.get('set-cookie');
  if (singleton === null) return [];
  if (singleton.includes(',')) throw new TypeError('combined Set-Cookie is forbidden');
  return [singleton];
};

const exactCookie = (
  value: string,
  expected: { name: string; secure: boolean; httpOnly: boolean; maximumAge: number },
): boolean => {
  const separator = value.indexOf('=');
  if (separator < 1 || value.slice(0, separator) !== expected.name) return false;
  const segments = value.split('; ');
  const cookieValue = segments[0]!.slice(separator + 1);
  const attributes = [
    `${expected.name}=${cookieValue}`,
    `Max-Age=${expected.maximumAge}`,
    'Path=/',
    ...(expected.secure ? ['Secure'] : []),
    ...(expected.httpOnly ? ['HttpOnly'] : []),
    'SameSite=Lax',
  ];
  if (segments.join('\0') !== attributes.join('\0')) return false;
  if (expected.maximumAge === 0) return cookieValue === '';
  return cookieValue.length > 0 && !/[\u0000-\u0020;,\u007f]/u.test(cookieValue);
};

const validateCookies = (
  state: PublicShareClientState,
  values: readonly string[],
  cookieHeader: string | undefined,
  cookieProfile: CookieProfile,
): void => {
  if (new Set(values.map((value) => value.slice(0, value.indexOf('=')))).size !== values.length)
    throw new TypeError('duplicate upstream cookie');
  if (state.state === 'ready') {
    if (
      values.length > 1 ||
      values.some(
        (value) =>
          !exactCookie(value, {
            name: cookieProfile.context,
            secure: cookieProfile.secure,
            httpOnly: true,
            maximumAge: 1_800,
          }),
      )
    )
      throw new TypeError('invalid ready Set-Cookie');
    return;
  }
  if (state.state === 'password-required') {
    if (values.length > 2) throw new TypeError('too many password bootstrap cookies');
    let familyCount = 0;
    let csrfCount = 0;
    for (const value of values) {
      if (
        exactCookie(value, {
          name: cookieProfile.family,
          secure: cookieProfile.secure,
          httpOnly: true,
          maximumAge: 0,
        })
      )
        familyCount += 1;
      else if (
        exactCookie(value, {
          name: cookieProfile.csrf,
          secure: cookieProfile.secure,
          httpOnly: false,
          maximumAge: 1_800,
        })
      )
        csrfCount += 1;
      else throw new TypeError('unexpected password bootstrap cookie');
    }
    if (
      familyCount > 1 ||
      csrfCount > 1 ||
      (familyCount === 1 && !selectedCookiePresent(cookieHeader, cookieProfile.family))
    )
      throw new TypeError('invalid password bootstrap cookie condition');
    return;
  }
  if (values.length !== 0) throw new TypeError('error state cannot set cookies');
};

const validateHeaders = (response: Response): void => {
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8' ||
    response.headers.get('cache-control')?.toLowerCase() !== 'private,no-store' ||
    response.headers.get('pragma')?.toLowerCase() !== 'no-cache' ||
    response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
    response.headers.get('referrer-policy')?.toLowerCase() !== 'no-referrer' ||
    response.headers.get('x-robots-tag')?.toLowerCase() !== 'noindex,nofollow,noarchive' ||
    response.headers.get('content-security-policy') !==
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" ||
    response.headers.get('vary')?.toLowerCase() !== 'cookie, origin' ||
    response.headers.has('etag') ||
    response.headers.has('content-disposition') ||
    response.headers.has('content-range') ||
    response.headers.has('accept-ranges')
  )
    throw new TypeError('public share response headers are corrupt');
};

const validateOutcomeHeaders = (response: Response, state: PublicShareClientState): void => {
  const retryAfter = response.headers.get('retry-after');
  if (response.status === 429) {
    if (state.state !== 'rate-limited' || retryAfter !== String(state.retryAfterSeconds))
      throw new TypeError('public share Retry-After mismatch');
  } else if (response.status === 503) {
    if (retryAfter !== '1') throw new TypeError('public share availability retry mismatch');
  } else if (retryAfter !== null) {
    throw new TypeError('unexpected public share Retry-After');
  }
  const allow = response.headers.get('allow');
  if ((response.status === 405 && allow !== 'GET') || (response.status !== 405 && allow !== null))
    throw new TypeError('public share Allow mismatch');
};

export const fetchPublicShareServerState = async (
  options: PublicShareServerOptions,
): Promise<PublicShareServerResult> => {
  const token = PublicShareTokenParserV1.parse(options.shareToken);
  if (!token.ok) return { state: { state: 'unavailable' }, setCookies: [] };
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `${new URL(options.apiOrigin).origin}/api/v1/public/shares/${token.data.value}`,
    {
      method: 'GET',
      ...(options.cookieHeader === undefined ? {} : { headers: { Cookie: options.cookieHeader } }),
      cache: 'no-store',
      redirect: 'manual',
    },
  );
  validateHeaders(response);
  const state = decodePublicShareBootstrapResponse(await response.json());
  const validStatus =
    (response.status === 200 && (state.state === 'ready' || state.state === 'password-required')) ||
    (response.status === 429 && state.state === 'rate-limited') ||
    ([400, 404, 405, 503].includes(response.status) && state.state === 'unavailable');
  if (!validStatus) throw new TypeError('public share status/state mismatch');
  validateOutcomeHeaders(response, state);
  const cookies = setCookieValues(response.headers);
  validateCookies(
    state,
    cookies,
    options.cookieHeader,
    profile(options.browserOrigin, options.nodeEnv),
  );
  return { state, setCookies: cookies };
};

const validatePasswordCookies = (
  result: PublicSharePasswordOutcome,
  values: readonly string[],
  cookieHeader: string | undefined,
  cookieProfile: CookieProfile,
): void => {
  if (new Set(values.map((value) => value.slice(0, value.indexOf('=')))).size !== values.length)
    throw new TypeError('duplicate upstream password cookie');
  if (result.kind === 'accepted') {
    if (values.length === 0) {
      if (!selectedCookiePresent(cookieHeader, cookieProfile.family))
        throw new TypeError('missing password family replacement');
      return;
    }
    if (
      values.length !== 1 ||
      !exactCookie(values[0]!, {
        name: cookieProfile.family,
        secure: cookieProfile.secure,
        httpOnly: true,
        maximumAge: 1_800,
      })
    )
      throw new TypeError('invalid password family replacement');
    return;
  }
  if (result.kind === 'invalid' && result.reason === 'csrf') {
    if (
      values.length !== 1 ||
      !exactCookie(values[0]!, {
        name: cookieProfile.csrf,
        secure: cookieProfile.secure,
        httpOnly: false,
        maximumAge: 0,
      })
    )
      throw new TypeError('invalid password CSRF deletion');
    return;
  }
  if (values.length !== 0) throw new TypeError('password failure cannot set cookies');
};

export const admitPublicSharePasswordServer = async (
  options: PublicSharePasswordServerOptions,
): Promise<PublicSharePasswordServerResult> => {
  const token = PublicShareTokenParserV1.parse(options.shareToken);
  const body = SharePasswordAdmissionRequestParserV1.parse({ password: options.password });
  if (!token.ok || !body.ok) return { kind: 'invalid', reason: 'body', setCookies: [] };
  const response = await (options.fetcher ?? fetch)(
    `${new URL(options.apiOrigin).origin}/api/v1/public/shares/${token.data.value}/password-sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: options.browserOrigin,
        'X-Sceneboard-Share-Csrf': options.csrfToken,
        ...(options.cookieHeader === undefined ? {} : { Cookie: options.cookieHeader }),
      },
      body: JSON.stringify(body.data.value),
      cache: 'no-store',
      redirect: 'manual',
    },
  );
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw new TypeError('public share password redirect is forbidden');
  let result: PublicSharePasswordOutcome;
  if (response.status === 204) {
    result = { kind: 'accepted' };
  } else {
    const parsed = ShareErrorEnvelopeParserV1.parse(await response.json());
    if (!parsed.ok) throw new TypeError('public share password response is corrupt');
    const error = parsed.data.value.error;
    if (response.status === 400 && error.code === 'INVALID_REQUEST')
      result = { kind: 'invalid', reason: error.details.reason };
    else if (response.status === 404 && error.code === 'BOARD_NOT_FOUND')
      result = { kind: 'not-admitted' };
    else if (response.status === 429 && error.code === 'RATE_LIMITED') {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (!Number.isInteger(retryAfter) || retryAfter < 1 || retryAfter > 900)
        throw new TypeError('public share password retry is corrupt');
      result = { kind: 'rate-limited', retryAfterSeconds: retryAfter };
    } else if (
      response.status === 503 &&
      error.code === 'SERVICE_UNAVAILABLE' &&
      response.headers.get('retry-after') === '1'
    )
      result = { kind: 'unavailable' };
    else throw new TypeError('public share password status mismatch');
  }
  const cookies = setCookieValues(response.headers);
  validatePasswordCookies(
    result,
    cookies,
    options.cookieHeader,
    profile(options.browserOrigin, options.nodeEnv),
  );
  return { ...result, setCookies: cookies } as PublicSharePasswordServerResult;
};
