export type ArtifactIsolationModeV1 = 'credentialless' | 'opaque-srcdoc' | 'unsupported';

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');

const canonicalRuntimeOrigin = (value: string): string => {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError('artifact runtime origin is invalid');
  return parsed.origin;
};

export const artifactIsolationModeV1 = (): ArtifactIsolationModeV1 => {
  if (typeof HTMLIFrameElement === 'undefined' || typeof MessageChannel === 'undefined')
    return 'unsupported';
  if ('credentialless' in HTMLIFrameElement.prototype) return 'credentialless';
  return 'srcdoc' in HTMLIFrameElement.prototype ? 'opaque-srcdoc' : 'unsupported';
};

export const artifactIsolationSupportedV1 = (): boolean =>
  artifactIsolationModeV1() !== 'unsupported';

export const readArtifactDocumentNonceV1 = (): string | null => {
  if (typeof document === 'undefined') return null;
  for (const script of document.querySelectorAll('script[nonce]')) {
    const nonce = script instanceof HTMLScriptElement ? script.nonce : undefined;
    if (typeof nonce === 'string' && nonce.length > 0) return nonce;
  }
  return null;
};

export const buildOpaqueArtifactRunnerDocumentV1 = (
  runtimeOrigin: string,
  nonce: string | null,
): string => {
  const canonicalOrigin = canonicalRuntimeOrigin(runtimeOrigin);
  if (nonce !== null && !/^[A-Za-z0-9+/_-]{16,128}={0,2}$/u.test(nonce))
    throw new TypeError('artifact document nonce is invalid');
  const escapedOrigin = escapeAttribute(canonicalOrigin);
  const nonceSource = nonce === null ? '' : ` 'nonce-${nonce}'`;
  const nonceAttribute = nonce === null ? '' : ` nonce="${escapeAttribute(nonce)}"`;
  const policy = [
    "default-src 'none'",
    `script-src ${canonicalOrigin}${nonceSource}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    'frame-src about: blob:',
    "worker-src 'none'",
    "manifest-src 'none'",
    `base-uri ${canonicalOrigin}`,
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><base href="${escapedOrigin}/"><title>SceneBoard isolated artifact runner</title><style>html,body{width:100%;height:100%;margin:0;overflow:hidden}body>iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script src="${escapedOrigin}/runner.js" crossorigin="anonymous"${nonceAttribute}></script></body></html>`;
};
