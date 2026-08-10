'use server';

import { cookies, headers } from 'next/headers';

import {
  admitPublicSharePasswordServer,
  fetchPublicShareServerState,
} from '../../../lib/api/public-share-server';
import type { PublicShareClientState } from '../../../lib/api/public-share-contract';
import { retryUnavailablePasswordAdmission } from './shared-board-password-retry';

export type SharedBoardActionState =
  | PublicShareClientState
  | { state: 'password-invalid'; csrfToken: string };

const requestContext = async (): Promise<{
  apiOrigin: string;
  browserOrigin: string;
  cookieHeader: string | undefined;
  nodeEnv: 'development' | 'test' | 'production';
}> => {
  const requestHeaders = await headers();
  const apiOrigin = process.env.NEXT_PUBLIC_BOARD_API_URL;
  if (apiOrigin === undefined) throw new TypeError('public API origin is unavailable');
  const originHeader = requestHeaders.get('origin');
  const host = requestHeaders.get('host');
  const forwardedProtocol = requestHeaders.get('x-forwarded-proto');
  const browserOrigin =
    originHeader ??
    (host === null ? null : `${forwardedProtocol === 'https' ? 'https' : 'http'}://${host}`);
  if (browserOrigin === null) throw new TypeError('public browser origin is unavailable');
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const nodeEnv =
    process.env.NODE_ENV === 'production'
      ? 'production'
      : process.env.NODE_ENV === 'test'
        ? 'test'
        : 'development';
  return {
    apiOrigin,
    browserOrigin: new URL(browserOrigin).origin,
    cookieHeader: cookieHeader.length === 0 ? undefined : cookieHeader,
    nodeEnv,
  };
};

const applySetCookies = async (values: readonly string[]): Promise<void> => {
  const cookieStore = await cookies();
  for (const value of values) {
    const segments = value.split('; ');
    const separator = segments[0]!.indexOf('=');
    const name = segments[0]!.slice(0, separator);
    const cookieValue = segments[0]!.slice(separator + 1);
    const maximumAge = Number(segments[1]!.slice('Max-Age='.length));
    cookieStore.set(name, cookieValue, {
      path: '/',
      secure: segments.includes('Secure'),
      httpOnly: segments.includes('HttpOnly'),
      sameSite: 'lax',
      maxAge: maximumAge,
    });
  }
};

const bootstrap = async (shareToken: string): Promise<PublicShareClientState> => {
  const context = await requestContext();
  const result = await fetchPublicShareServerState({ ...context, shareToken });
  await applySetCookies(result.setCookies);
  return result.state;
};

export const bootstrapSharedBoard = async (shareToken: string): Promise<SharedBoardActionState> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const state = await bootstrap(shareToken);
      if (state.state !== 'unavailable' || attempt === 1) return state;
    } catch {
      if (attempt === 1) return { state: 'unavailable' };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { state: 'unavailable' };
};

export const submitSharedBoardPassword = async (
  shareToken: string,
  csrfToken: string,
  password: string,
): Promise<SharedBoardActionState> => {
  try {
    const context = await requestContext();
    const result = await retryUnavailablePasswordAdmission(
      () =>
        admitPublicSharePasswordServer({
          ...context,
          shareToken,
          csrfToken,
          password,
        }),
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    );
    await applySetCookies(result.setCookies);
    if (result.kind === 'rate-limited')
      return { state: 'rate-limited', retryAfterSeconds: result.retryAfterSeconds };
    if (result.kind === 'unavailable') return { state: 'unavailable' };
    const confirmed = await bootstrap(shareToken);
    if (
      (result.kind === 'not-admitted' || (result.kind === 'invalid' && result.reason === 'body')) &&
      confirmed.state === 'password-required'
    )
      return { state: 'password-invalid', csrfToken: confirmed.csrfToken };
    return confirmed;
  } catch {
    return { state: 'unavailable' };
  }
};
