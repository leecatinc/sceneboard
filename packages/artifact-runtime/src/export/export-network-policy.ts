const SESSION_ID_V1 = /^[A-Za-z0-9_-]{22}$/u;
const SHA256_V1 = /^[a-f0-9]{64}$/u;
const RUNTIME_ASSET_V1 = /^\/assets\/(?:outer|mermaid|three)\.[a-f0-9]{64}\.js$/u;
const IPV4_OCTET_V1 = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const IPV4_LOOPBACK_V1 = new RegExp(`^127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');
const isLoopbackHost = (value: string): boolean =>
  value === '[::1]' || value === '::1' || IPV4_LOOPBACK_V1.test(value);

const loopbackOrigin = (value: string, label: string): URL => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError(`${label} must be one canonical loopback HTTP origin`);
  return parsed;
};

export type ExportNetworkPolicyV1 = Readonly<{
  webOrigin: string;
  apiOrigin: string;
  runtimeOrigin: string;
  sessionId: string;
}>;

export const createExportNetworkPolicyV1 = (input: ExportNetworkPolicyV1) => {
  const web = loopbackOrigin(input.webOrigin, 'export web origin').origin;
  const api = loopbackOrigin(input.apiOrigin, 'export API origin').origin;
  const runtime = loopbackOrigin(input.runtimeOrigin, 'export artifact runtime origin').origin;
  if (!SESSION_ID_V1.test(input.sessionId))
    throw new TypeError('export session identifier is invalid');
  if (web === runtime) throw new TypeError('export web and artifact runtime origins must differ');
  const documentPath = `/internal/export-render/${input.sessionId}`;
  const brokerPrefix = `/internal/v1/export-render/${input.sessionId}/`;
  const brokerRequest = (url: URL, resourceType: string): boolean => {
    if (url.origin !== api || !['fetch', 'xhr', 'image', 'font'].includes(resourceType))
      return false;
    if (url.pathname === `${brokerPrefix}projection`) return true;
    const resource = url.pathname.slice(`${brokerPrefix}resources/`.length);
    return url.pathname.startsWith(`${brokerPrefix}resources/`) && SHA256_V1.test(resource);
  };
  const strictUrl = (value: string): URL | null => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    return url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      ? url
      : null;
  };
  return Object.freeze({
    webOrigin: web,
    apiOrigin: api,
    runtimeOrigin: runtime,
    documentUrl: `${web}${documentPath}`,
    isBrokerRequest(value: string, resourceType: string): boolean {
      const url = strictUrl(value);
      return url !== null && brokerRequest(url, resourceType);
    },
    allows(value: string, resourceType: string): boolean {
      const url = strictUrl(value);
      if (url === null) return false;
      if (url.origin === web) {
        if (url.pathname === documentPath && resourceType === 'document') return true;
        return (
          url.pathname.startsWith('/_next/static/') &&
          (resourceType === 'script' || resourceType === 'stylesheet' || resourceType === 'font')
        );
      }
      if (url.origin === api) return brokerRequest(url, resourceType);
      if (url.origin === runtime)
        return (
          (resourceType === 'document' || resourceType === 'script') &&
          (url.pathname === '/runner' ||
            url.pathname === '/runner.js' ||
            RUNTIME_ASSET_V1.test(url.pathname))
        );
      return false;
    },
  });
};
