import { NextRequest, NextResponse } from 'next/server';

const canonicalOrigin = (value: string | undefined): string => {
  if (value === undefined) throw new TypeError('public share API origin is unavailable');
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError('public share API origin is invalid');
  return parsed.origin;
};

const IPV4_OCTET_V1 = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const IPV4_LOOPBACK_V1 = new RegExp(`^127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');
const IPV4_MAPPED_LOOPBACK_V1 = new RegExp(`^::ffff:127(?:\\.${IPV4_OCTET_V1}){3}$`, 'iu');
export const isLoopbackHostV1 = (value: string): boolean =>
  value === '[::1]' ||
  value === '::1' ||
  IPV4_LOOPBACK_V1.test(value) ||
  IPV4_MAPPED_LOOPBACK_V1.test(value);

const canonicalLoopbackOrigin = (value: string | undefined, label: string): string => {
  const origin = canonicalOrigin(value);
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || !isLoopbackHostV1(parsed.hostname))
    throw new TypeError(`${label} must be a loopback HTTP origin`);
  return origin;
};

export const matchesExportWebHostV1 = (
  host: string | null,
  configuredOrigin: string | undefined,
): boolean => {
  const origin = canonicalLoopbackOrigin(configuredOrigin, 'export web origin');
  return host === new URL(origin).host;
};

export const buildPublicShareDocumentPolicyV1 = (nonce: string, apiOrigin: string): string => {
  if (!/^[A-Za-z0-9+/]{16,128}={0,2}$/u.test(nonce))
    throw new TypeError('public share nonce is invalid');
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${canonicalOrigin(apiOrigin)}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "worker-src 'none'",
  ].join('; ');
};

export const buildExportRenderDocumentPolicyV1 = (
  nonce: string,
  apiOrigin: string,
  runtimeOrigin: string,
): string => {
  if (!/^[A-Za-z0-9+/]{16,128}={0,2}$/u.test(nonce))
    throw new TypeError('export render nonce is invalid');
  const api = canonicalLoopbackOrigin(apiOrigin, 'export API origin');
  const runtime = canonicalLoopbackOrigin(runtimeOrigin, 'export runtime origin');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src ${api} data:`,
    "media-src 'none'",
    `font-src ${api}`,
    `connect-src ${api}`,
    `frame-src ${runtime}`,
    "frame-ancestors 'none'",
    "form-action 'none'",
    "worker-src 'none'",
  ].join('; ');
};

const createNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
};

export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const isExportRender = request.nextUrl.pathname.startsWith('/internal/export-render/');
  if (isExportRender) {
    const authorization = request.headers.get('authorization');
    const forwarded = request.headers.get('x-forwarded-for');
    const remoteHosts = forwarded === null ? [] : forwarded.split(',').map((value) => value.trim());
    if (
      !matchesExportWebHostV1(
        request.headers.get('host'),
        process.env.SCENEBOARD_EXPORT_WEB_ORIGIN,
      ) ||
      authorization === null ||
      !/^SceneBoard-Export [A-Za-z0-9_-]{22}$/u.test(authorization) ||
      remoteHosts.some((host) => !isLoopbackHostV1(host))
    )
      return new NextResponse(null, { status: 404 });
  }
  const policy = isExportRender
    ? buildExportRenderDocumentPolicyV1(
        nonce,
        process.env.SCENEBOARD_EXPORT_API_ORIGIN ?? '',
        process.env.SCENEBOARD_EXPORT_ARTIFACT_RUNTIME_ORIGIN ?? '',
      )
    : buildPublicShareDocumentPolicyV1(nonce, process.env.NEXT_PUBLIC_BOARD_API_URL ?? '');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'private,no-store');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Robots-Tag', 'noindex,nofollow,noarchive');
  return response;
}

export const config = {
  matcher: ['/s/:path*', '/internal/export-render/:path*'],
};
