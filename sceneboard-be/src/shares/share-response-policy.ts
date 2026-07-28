import type { PublicShareFailureStatus } from './public-share.error.js';
import type { MediaMimeV1 } from '@sceneboard/board-schema';

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

export const applyPublicMediaHeaders = (
  response: PublicHeaderResponse,
  status: number,
  input: {
    mime?: MediaMimeV1 | undefined;
    sha256Hex?: string | undefined;
    contentRangeLength?: number | null | undefined;
  } = {},
): void => {
  common(response);
  response.setHeader('Vary', 'Cookie');
  response.setHeader('Cache-Control', 'private,no-store');
  if (status === 200 && input.mime !== undefined && input.sha256Hex !== undefined) {
    const suffix =
      input.mime === 'image/png' ? 'png' : input.mime === 'image/jpeg' ? 'jpg' : 'webp';
    response.setHeader('Content-Type', input.mime);
    response.setHeader('ETag', `"sha256-${input.sha256Hex}"`);
    response.setHeader('Content-Disposition', `inline; filename="media.${suffix}"`);
    return;
  }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Content-Security-Policy', apiCsp);
  if (status === 405) response.setHeader('Allow', 'GET');
  if (status === 416 && input.contentRangeLength !== null && input.contentRangeLength !== undefined)
    response.setHeader('Content-Range', `bytes */${input.contentRangeLength}`);
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
