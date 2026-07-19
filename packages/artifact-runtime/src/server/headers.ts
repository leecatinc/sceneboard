import { buildRunnerContentSecurityPolicyV1 } from '../policy/csp.js';

export type RuntimeHeadersV1 = Readonly<Record<string, string>>;

const PERMISSIONS_POLICY = 'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), microphone=(), payment=(), publickey-credentials-get=(), storage-access=(), usb=()';

export const buildRunnerHeadersV1 = (input: {
  appOrigin: string;
  runtimeOrigin: string;
}): RuntimeHeadersV1 => Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': buildRunnerContentSecurityPolicyV1(input),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, max-age=0',
  'Permissions-Policy': PERMISSIONS_POLICY,
});

export const buildFixedAssetHeadersV1 = (): RuntimeHeadersV1 => Object.freeze({
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Origin-Agent-Cluster': '?1',
});

export const buildHealthHeadersV1 = (): RuntimeHeadersV1 => Object.freeze({
  'Content-Type': 'text/plain',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Origin-Agent-Cluster': '?1',
});

const FORBIDDEN = new Set([
  'access-control-allow-origin',
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
    if (seen.has(lower) || FORBIDDEN.has(lower) || value.includes('\r') || value.includes('\n')) {
      throw new TypeError('runtime response headers are unsafe');
    }
    seen.add(lower);
  }
};
