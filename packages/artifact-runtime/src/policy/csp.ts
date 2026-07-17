import { canonicalOriginV1 } from '../topology/index.js';

export const OUTER_SANDBOX_TOKENS_V1 = 'allow-scripts' as const;
export const INNER_SANDBOX_TOKENS_V1 = 'allow-scripts' as const;

export const buildRunnerContentSecurityPolicyV1 = (input: {
  appOrigin: string;
  runtimeOrigin: string;
}): string => {
  const app = canonicalOriginV1(input.appOrigin, 'app origin').origin;
  const runtime = canonicalOriginV1(input.runtimeOrigin, 'runtime origin').origin;
  if (app === runtime) throw new TypeError('runner and app origins must be distinct');
  return [
    "default-src 'none'",
    `script-src ${runtime}`,
    `style-src ${runtime}`,
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    'frame-src blob:',
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${app}`,
    'sandbox allow-scripts',
  ].join('; ');
};

export const buildInnerPolicyV1 = (nonce: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(nonce)) throw new TypeError('inner CSP nonce must be 128-bit base64url');
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    'font-src data:',
    'media-src data: blob:',
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
  ].join('; ');
};
