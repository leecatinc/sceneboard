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

const createNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
};

export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const policy = buildPublicShareDocumentPolicyV1(
    nonce,
    process.env.NEXT_PUBLIC_BOARD_API_URL ?? '',
  );
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

export const config = { matcher: ['/s/:path*'] };
