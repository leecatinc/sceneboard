import type { PublicShareFailureStatus } from './public-share.error.js';

export interface PublicHeaderResponse {
  setHeader(name: string, value: string): unknown;
}

const common = (response: PublicHeaderResponse): void => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex,nofollow,noarchive');
};

const apiCsp = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export const applyPublicProjectionHeaders = (
  response: PublicHeaderResponse,
  status: number,
): void => {
  common(response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private,no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Content-Security-Policy', apiCsp);
  response.setHeader('Vary', 'Cookie, Origin');
  if (status === 405) response.setHeader('Allow', 'GET');
};

export const applyPublicArtifactHeaders = (
  response: PublicHeaderResponse,
  status: number,
  contentRangeLength: number | null = null,
): void => {
  common(response);
  response.setHeader('Vary', 'Cookie');
  response.setHeader('Content-Security-Policy', apiCsp);
  if (status === 200) {
    response.setHeader('Content-Type', 'application/vnd.leecat.artifact-package.v1');
    response.setHeader('Cache-Control', 'private,no-store');
    response.setHeader('Content-Disposition', 'attachment; filename="sceneboard-artifact.pkg"');
    return;
  }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private,no-store');
  response.setHeader('Pragma', 'no-cache');
  if (status === 405) response.setHeader('Allow', 'GET');
  if (status === 416 && contentRangeLength !== null)
    response.setHeader('Content-Range', `bytes */${contentRangeLength}`);
};

export const publicFailureBody = (
  status: PublicShareFailureStatus,
  retryAfterSeconds: number | null,
): { state: 'unavailable' } | { state: 'rate-limited'; retryAfterSeconds: number } =>
  status === 429
    ? {
        state: 'rate-limited',
        retryAfterSeconds: Math.max(1, Math.min(900, Math.ceil(retryAfterSeconds ?? 1))),
      }
    : { state: 'unavailable' };
