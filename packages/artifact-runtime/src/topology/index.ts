export const ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2 = 'auth-artifact-origin-evidence/v2' as const;

export type ArtifactAppEnvironmentV1 = 'development' | 'test' | 'staging' | 'production';

export type AuthArtifactOriginEvidenceV2 = {
  schemaVersion: typeof ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2;
  generatedAt: string;
  expiresAt: string;
  frontendOrigin: string;
  apiOrigin: string;
  runtimeOrigin: string;
  appEnv: ArtifactAppEnvironmentV1;
  frontendInputSha256: string;
  backendInputSha256: string;
  runtimeInputSha256: string;
};

export type ArtifactRuntimeTopologyInputV1 = {
  appEnv: ArtifactAppEnvironmentV1;
  frontendOrigin: string;
  apiOrigin: string;
  runtimeOrigin: string;
  listenHost: string;
  listenPort: number;
  evidence: unknown;
  expectedInputSha256: {
    frontend: string;
    backend: string;
    runtime: string;
  };
  now?: Date;
};

export type ArtifactRuntimeTopologyV1 = {
  appEnv: ArtifactAppEnvironmentV1;
  frontendOrigin: string;
  apiOrigin: string;
  runtimeOrigin: string;
  expectedHost: string;
  listenHost: string;
  listenPort: number;
};

const HEX_64 = /^[0-9a-f]{64}$/u;
const EVIDENCE_KEYS = [
  'schemaVersion',
  'generatedAt',
  'expiresAt',
  'frontendOrigin',
  'apiOrigin',
  'runtimeOrigin',
  'appEnv',
  'frontendInputSha256',
  'backendInputSha256',
  'runtimeInputSha256',
] as const;

export const canonicalOriginV1 = (input: string, label = 'origin'): URL => {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input !== input.trim() ||
    /[^\x20-\x7e]/u.test(input)
  ) {
    throw new TypeError(`${label} must be one ASCII origin`);
  }
  let value: URL;
  try {
    value = new URL(input);
  } catch {
    throw new TypeError(`${label} must be a valid origin`);
  }
  if (
    (value.protocol !== 'http:' && value.protocol !== 'https:') ||
    value.username !== '' ||
    value.password !== '' ||
    value.pathname !== '/' ||
    value.search !== '' ||
    value.hash !== '' ||
    value.origin !== input
  ) {
    throw new TypeError(`${label} must be a canonical bare origin`);
  }
  return value;
};

const evidenceV2 = (input: unknown): AuthArtifactOriginEvidenceV2 => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('origin evidence must be an object');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EVIDENCE_KEYS.length ||
    EVIDENCE_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError('origin evidence must have exact v2 keys');
  }
  for (const key of keys) {
    if (!EVIDENCE_KEYS.includes(key as (typeof EVIDENCE_KEYS)[number])) {
      throw new TypeError('origin evidence contains an unknown key');
    }
  }
  if (
    value.schemaVersion !== ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2 ||
    !['development', 'test', 'staging', 'production'].includes(String(value.appEnv))
  ) {
    throw new TypeError('origin evidence schema or environment is invalid');
  }
  for (const key of [
    'generatedAt',
    'expiresAt',
    'frontendOrigin',
    'apiOrigin',
    'runtimeOrigin',
  ] as const) {
    if (typeof value[key] !== 'string') throw new TypeError(`origin evidence ${key} is invalid`);
  }
  for (const key of ['frontendInputSha256', 'backendInputSha256', 'runtimeInputSha256'] as const) {
    if (typeof value[key] !== 'string' || !HEX_64.test(value[key])) {
      throw new TypeError(`origin evidence ${key} is invalid`);
    }
  }
  return value as AuthArtifactOriginEvidenceV2;
};

export const assertArtifactRuntimeTopologyV1 = (
  input: ArtifactRuntimeTopologyInputV1,
): ArtifactRuntimeTopologyV1 => {
  const frontend = canonicalOriginV1(input.frontendOrigin, 'frontend origin');
  const api = canonicalOriginV1(input.apiOrigin, 'API origin');
  const runtime = canonicalOriginV1(input.runtimeOrigin, 'runtime origin');
  if (runtime.origin === frontend.origin || runtime.origin === api.origin) {
    throw new TypeError('runtime origin must be distinct from app and API');
  }
  if (runtime.hostname === frontend.hostname || runtime.hostname === api.hostname) {
    throw new TypeError('artifact runtime must use a separate cookie hostname');
  }
  if (!Number.isInteger(input.listenPort) || input.listenPort < 1 || input.listenPort > 65_535) {
    throw new TypeError('runtime listen port is invalid');
  }
  // Reverse-proxy deployment: the pod binds an internal host:port (e.g. 0.0.0.0:3412)
  // while the public runtime origin (e.g. https://artifact.sceneboard.dev) is served by
  // the ingress. The listener is validated as a bindable host:port, decoupled from the
  // public origin, instead of requiring an exact match.
  if (input.listenHost.length === 0) {
    throw new TypeError('runtime listener host is required');
  }
  if (input.appEnv === 'development' || input.appEnv === 'test') {
    if (
      frontend.origin !== 'http://127.0.0.1:3410' ||
      api.origin !== 'http://127.0.0.1:3411' ||
      runtime.origin !== 'http://127.0.0.2:3412'
    ) {
      throw new TypeError('local topology must use the frozen 3410/3411/3412 loopback origins');
    }
  } else {
    if (
      frontend.protocol !== 'https:' ||
      api.protocol !== 'https:' ||
      runtime.protocol !== 'https:'
    ) {
      throw new TypeError('staging and production origins must use HTTPS');
    }
    if (runtime.hostname === frontend.hostname || runtime.hostname === api.hostname) {
      throw new TypeError('the production runtime must use a separate cookie hostname');
    }
  }

  const evidence = evidenceV2(input.evidence);
  if (
    evidence.appEnv !== input.appEnv ||
    evidence.frontendOrigin !== frontend.origin ||
    evidence.apiOrigin !== api.origin ||
    evidence.runtimeOrigin !== runtime.origin ||
    evidence.frontendInputSha256 !== input.expectedInputSha256.frontend ||
    evidence.backendInputSha256 !== input.expectedInputSha256.backend ||
    evidence.runtimeInputSha256 !== input.expectedInputSha256.runtime
  ) {
    throw new TypeError('origin evidence does not match the resolved runtime inputs');
  }
  const generatedAt = Date.parse(evidence.generatedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - generatedAt !== 15 * 60 * 1_000 ||
    generatedAt > now ||
    now >= expiresAt
  ) {
    throw new TypeError('origin evidence is stale or has an invalid validity interval');
  }
  return {
    appEnv: input.appEnv,
    frontendOrigin: frontend.origin,
    apiOrigin: api.origin,
    runtimeOrigin: runtime.origin,
    expectedHost: runtime.host,
    listenHost: input.listenHost,
    listenPort: input.listenPort,
  };
};
