import { buildRunnerContentSecurityPolicyV1 } from '../policy/csp.js';

export type RuntimeHeadersV1 = Readonly<Record<string, string>>;

const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), microphone=(), payment=(), publickey-credentials-get=(), storage-access=(), usb=()';

// OAC is intentionally omitted for this credentialless sandbox origin. Chrome 147 terminates the
// renderer when an embedded runtime tries to switch an already site-keyed origin to origin-keyed.

export const buildRunnerHeadersV1 = (input: {
  appOrigin: string;
  runtimeOrigin: string;
}): RuntimeHeadersV1 =>
  Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': buildRunnerContentSecurityPolicyV1(input),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, max-age=0',
    'Permissions-Policy': PERMISSIONS_POLICY,
  });

export const buildFixedAssetHeadersV1 = (): RuntimeHeadersV1 =>
  Object.freeze({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  });

export const buildOpaqueRunnerScriptHeadersV1 = (): RuntimeHeadersV1 =>
  Object.freeze({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  });

export const buildHealthHeadersV1 = (): RuntimeHeadersV1 =>
  Object.freeze({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

const FORBIDDEN = new Set([
  'access-control-allow-credentials',
  'set-cookie',
  'x-frame-options',
  'report-to',
  'reporting-endpoints',
]);

export const assertRuntimeHeadersV1 = (headers: RuntimeHeadersV1): void => {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      seen.has(lower) ||
      FORBIDDEN.has(lower) ||
      (lower === 'access-control-allow-origin' && value !== '*') ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      throw new TypeError('runtime response headers are unsafe');
    }
    seen.add(lower);
  }
};
