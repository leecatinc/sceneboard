import type { MediaMimeV1 } from '@sceneboard/board-schema';

export interface MediaHeaderResponse {
  removeHeader?(name: string): unknown;
  setHeader(name: string, value: string): unknown;
}

export type AuthorizedMediaResponseV1 = Readonly<{
  bytes: Buffer;
  mime: MediaMimeV1;
  sha256Hex: string;
  byteLength: number;
}>;

const common = (response: MediaHeaderResponse): void => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex,nofollow,noarchive');
  response.setHeader('Vary', 'Cookie');
};

const extension = (mime: MediaMimeV1): 'png' | 'jpg' | 'webp' =>
  mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';

export const quotedMediaEtag = (sha256Hex: string): string => `"${sha256Hex}"`;

export const isExactStrongMediaEtag = (value: string | undefined, expected: string): boolean =>
  value === undefined || (/^"[0-9a-f]{64}"$/u.test(value) && value === expected);

export const applyAccountMediaHeaders = (
  response: MediaHeaderResponse,
  status: 200 | 304 | 416,
  media: AuthorizedMediaResponseV1,
): void => {
  common(response);
  response.setHeader('Cache-Control', 'private,max-age=0,must-revalidate');
  if (status === 416) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Content-Range', `bytes */${media.byteLength}`);
    return;
  }
  response.setHeader('ETag', quotedMediaEtag(media.sha256Hex));
  if (status === 304) return;
  response.setHeader('Content-Type', media.mime);
  response.setHeader('Content-Disposition', `inline; filename="media.${extension(media.mime)}"`);
};

export const applyAccountMediaErrorHeaders = (
  response: MediaHeaderResponse,
  status: number,
): void => {
  common(response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private,no-store');
  response.setHeader('Pragma', 'no-cache');
  if (status === 405) response.setHeader('Allow', 'GET');
  if (status === 503) response.setHeader('Retry-After', '1');
};
