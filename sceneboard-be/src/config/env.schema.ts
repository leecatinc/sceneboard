import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { createCursorMacKeyV1, type CursorMacKeyV1 } from '../common/security/cursor-mac-key.js';
import {
  REVISION_RETENTION_DEFAULT,
  REVISION_RETENTION_MAXIMUM,
  REVISION_RETENTION_MINIMUM,
} from '../revisions/retention/retention.types.js';
import { decodeBase64UrlStrict } from './security.constants.js';

export type AppEnvironmentName = 'development' | 'test' | 'staging' | 'production';
export type NodeEnvironmentName = 'development' | 'test' | 'production';
export const APP_ENVIRONMENT = Symbol('APP_ENVIRONMENT');

export interface AppEnvironment {
  appEnv: AppEnvironmentName;
  nodeEnv: NodeEnvironmentName;
  port: number;
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
    database: number;
    keyPrefix: string;
  };
  gmail: {
    user: string;
    appPassword: string;
  };
  keys: {
    sessionToken: Buffer;
    grantToken: Buffer;
    csrf: Buffer;
    pairingCodePepper: Buffer;
    auditHmac: Buffer;
    rateLimitHmac: Buffer;
  };
  cursorMacKey: CursorMacKeyV1;
  streamKeyMaterial: Buffer;
  bcryptCost: number;
  authFailureMinMs: number;
  authFailureJitterMs: number;
  pairingFailureMinMs: number;
  pairingFailureJitterMs: number;
  browserOrigin: string;
  publicApiOrigin: string;
  trustedProxyCidrs: string[];
  revisionRetentionCount: number;
  historyRetainedEmissionEnabled: boolean;
  revisionReclamationEnabled: boolean;
  accountApiKeyIssuanceEnabled: boolean;
  accountApiKeyAuthEnabled: boolean;
  boardDocumentV3WriteEnabled: boolean;
}

export type PersistenceEnvironment = Pick<AppEnvironment, 'mysql' | 'redis'>;

export class EnvironmentValidationError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`Invalid environment value for ${key}: ${message}`);
    this.name = 'EnvironmentValidationError';
    this.key = key;
  }
}

type EnvironmentInput = Record<string, string | undefined>;

const APP_ENVIRONMENTS = new Set<AppEnvironmentName>([
  'development',
  'test',
  'staging',
  'production',
]);
const NODE_ENVIRONMENTS = new Set<NodeEnvironmentName>(['development', 'test', 'production']);
const PLACEHOLDER_PATTERN = /^(?:<[^>]+>|changeme|replace-me|set-by-secret)$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const ASCII_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CERTIFICATION_ATTEMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CERTIFICATION_DATABASE_PATTERN = /^sceneboard_cert_[a-f0-9]{20}$/u;
const CERTIFICATION_DATABASE_PURPOSES = new Set(['browser', 'migration']);

const required = (input: EnvironmentInput, key: string): string => {
  const value = input[key];
  if (value === undefined || value.length === 0)
    throw new EnvironmentValidationError(key, 'is required');
  if (PLACEHOLDER_PATTERN.test(value))
    throw new EnvironmentValidationError(key, 'placeholder values are forbidden');
  return value;
};

const parseEnum = <Value extends string>(
  input: EnvironmentInput,
  key: string,
  allowed: ReadonlySet<Value>,
): Value => {
  const value = required(input, key);
  if (!allowed.has(value as Value))
    throw new EnvironmentValidationError(key, 'is outside the allowed set');
  return value as Value;
};

const parseInteger = (
  input: EnvironmentInput,
  key: string,
  minimum: number,
  maximum: number,
): number => {
  const value = required(input, key);
  if (!DECIMAL_PATTERN.test(value))
    throw new EnvironmentValidationError(key, 'must be a canonical decimal integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new EnvironmentValidationError(key, `must be between ${minimum} and ${maximum}`);
  }
  return parsed;
};

const parseOptionalInteger = (
  input: EnvironmentInput,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number =>
  parseInteger({ ...input, [key]: input[key] ?? String(fallback) }, key, minimum, maximum);

const parseOptionalBoolean = (input: EnvironmentInput, key: string, fallback: boolean): boolean => {
  const value = input[key] ?? String(fallback);
  if (value !== 'true' && value !== 'false') {
    throw new EnvironmentValidationError(key, 'must be exactly true or false');
  }
  return value === 'true';
};

const parseBoundedText = (
  input: EnvironmentInput,
  key: string,
  minimumBytes: number,
  maximumBytes: number,
): string => {
  const value = required(input, key);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (CONTROL_PATTERN.test(value) || bytes < minimumBytes || bytes > maximumBytes) {
    throw new EnvironmentValidationError(
      key,
      `must contain ${minimumBytes}-${maximumBytes} non-control UTF-8 bytes`,
    );
  }
  return value;
};

const parseHost = (input: EnvironmentInput, key: string): string => {
  const value = required(input, key);
  if (value.length > 253 || (!isIP(value) && !ASCII_HOST_PATTERN.test(value))) {
    throw new EnvironmentValidationError(key, 'must be an ASCII hostname or IP literal');
  }
  return value;
};

const parseGmailUser = (input: EnvironmentInput): string => {
  const value = parseBoundedText(input, 'SCENEBOARD_GMAIL_USER', 5, 254);
  if (!/^[\x20-\x7e]+@[A-Za-z0-9.-]+$/.test(value) || value !== value.trim()) {
    throw new EnvironmentValidationError('SCENEBOARD_GMAIL_USER', 'must be an ASCII email address');
  }
  return value;
};

interface ParsedOrigin {
  value: string;
  protocol: 'http:' | 'https:';
  hostname: string;
}

const parseOrigin = (input: EnvironmentInput, key: string): ParsedOrigin => {
  const value = required(input, key);
  if (value !== value.trim() || value.includes(',') || /[^\x20-\x7e]/u.test(value)) {
    throw new EnvironmentValidationError(key, 'must be one ASCII origin');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentValidationError(key, 'must be a valid URL origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  ) {
    throw new EnvironmentValidationError(
      key,
      'must use its canonical bare http(s) origin serialization',
    );
  }
  return { value: url.origin, protocol: url.protocol, hostname: url.hostname };
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const parseKey = (input: EnvironmentInput, key: string): Buffer => {
  const value = required(input, key);
  try {
    return decodeBase64UrlStrict(value, { minimumBytes: 32 });
  } catch {
    throw new EnvironmentValidationError(
      key,
      'must be canonical unpadded base64url encoding at least 32 bytes',
    );
  }
};

const parseStreamKey = (input: EnvironmentInput): Buffer => {
  const value = required(input, 'BOARD_STREAM_KEY_B64');
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new EnvironmentValidationError(
      'BOARD_STREAM_KEY_B64',
      'must be canonical padded RFC 4648 base64',
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new EnvironmentValidationError('BOARD_STREAM_KEY_B64', 'must decode to exactly 32 bytes');
  }
  return decoded;
};

const canonicalIpv4 = (address: string): boolean => {
  if (isIP(address) !== 4) return false;
  return address.split('.').every((part) => String(Number(part)) === part);
};

const parseTrustedProxyCidrs = (input: EnvironmentInput): string[] => {
  const source = input.TRUSTED_PROXY_CIDRS ?? '';
  if (source === '') return [];
  const entries = source.split(',');
  if (entries.length > 16 || entries.some((entry) => entry === '' || entry !== entry.trim())) {
    throw new EnvironmentValidationError(
      'TRUSTED_PROXY_CIDRS',
      'must contain 1-16 comma-separated canonical CIDRs',
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.lastIndexOf('/');
    if (separator <= 0)
      throw new EnvironmentValidationError('TRUSTED_PROXY_CIDRS', 'CIDR prefix is required');
    const address = entry.slice(0, separator);
    const prefixSource = entry.slice(separator + 1);
    const family = isIP(address);
    if (!DECIMAL_PATTERN.test(prefixSource) || family === 0) {
      throw new EnvironmentValidationError('TRUSTED_PROXY_CIDRS', 'contains an invalid CIDR');
    }
    const prefix = Number(prefixSource);
    if (
      prefix > (family === 4 ? 32 : 128) ||
      (family === 4 && !canonicalIpv4(address)) ||
      address !== address.toLowerCase()
    ) {
      throw new EnvironmentValidationError('TRUSTED_PROXY_CIDRS', 'contains a non-canonical CIDR');
    }
    if (seen.has(entry))
      throw new EnvironmentValidationError('TRUSTED_PROXY_CIDRS', 'contains a duplicate CIDR');
    seen.add(entry);
  }
  return entries;
};

export const parsePersistenceEnvironment = (input: EnvironmentInput): PersistenceEnvironment => {
  const mysqlDatabase = required(input, 'MYSQL_DATABASE');
  const disposableDatabase = input.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE;
  if (disposableDatabase === undefined) {
    if (mysqlDatabase !== 'sceneboard')
      throw new EnvironmentValidationError('MYSQL_DATABASE', 'must be sceneboard');
  } else {
    const attemptId = required(input, 'SCENEBOARD_CERTIFICATION_ATTEMPT_ID');
    const purpose = required(input, 'SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE');
    if (
      disposableDatabase !== 'true' ||
      input.APP_ENV !== 'test' ||
      input.NODE_ENV !== 'test' ||
      !CERTIFICATION_ATTEMPT_PATTERN.test(attemptId) ||
      !CERTIFICATION_DATABASE_PURPOSES.has(purpose) ||
      !CERTIFICATION_DATABASE_PATTERN.test(mysqlDatabase)
    ) {
      throw new EnvironmentValidationError(
        'SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE',
        'requires an exact test-only certification identity',
      );
    }
    const fixtureAttemptId = `${attemptId}.${purpose}`;
    const expectedDatabase = `sceneboard_cert_${createHash('sha256')
      .update(fixtureAttemptId)
      .digest('hex')
      .slice(0, 20)}`;
    const expectedOwnerSha256 = createHash('sha256')
      .update(`sceneboard-certification-database:${fixtureAttemptId}`)
      .digest('hex');
    if (mysqlDatabase !== expectedDatabase)
      throw new EnvironmentValidationError('MYSQL_DATABASE', 'does not match the attempt');
    if (input.SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256 !== expectedOwnerSha256) {
      throw new EnvironmentValidationError(
        'SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256',
        'does not match the attempt',
      );
    }
  }
  const redisKeyPrefix = required(input, 'REDIS_KEY_PREFIX');
  if (redisKeyPrefix !== 'sceneboard:')
    throw new EnvironmentValidationError('REDIS_KEY_PREFIX', 'must be sceneboard:');
  return {
    mysql: {
      host: parseHost(input, 'MYSQL_HOST'),
      port: parseInteger(input, 'MYSQL_PORT', 1, 65_535),
      user: parseBoundedText(input, 'MYSQL_USER', 1, 128),
      password: parseBoundedText(input, 'MYSQL_PASSWORD', 1, 1_024),
      database: mysqlDatabase,
    },
    redis: {
      host: parseHost(input, 'REDIS_HOST'),
      port: parseInteger(input, 'REDIS_PORT', 1, 65_535),
      password: parseBoundedText(input, 'REDIS_PASSWORD', 1, 1_024),
      database: parseInteger(input, 'REDIS_DB', 0, 15),
      keyPrefix: redisKeyPrefix,
    },
  };
};

export const parseEnvironment = (input: EnvironmentInput): AppEnvironment => {
  const appEnv = parseEnum(input, 'APP_ENV', APP_ENVIRONMENTS);
  const nodeEnv = parseEnum(input, 'NODE_ENV', NODE_ENVIRONMENTS);
  if ((appEnv === 'staging' || appEnv === 'production') && nodeEnv !== 'production') {
    throw new EnvironmentValidationError(
      'NODE_ENV',
      'must be production for staging or production',
    );
  }

  const browser = parseOrigin(input, 'BOARD_ALLOWED_ORIGINS');
  const api = parseOrigin(input, 'BOARD_PUBLIC_API_ORIGIN');
  if (browser.protocol !== api.protocol || browser.hostname !== api.hostname) {
    throw new EnvironmentValidationError(
      'BOARD_PUBLIC_API_ORIGIN',
      'must use the browser origin scheme and hostname',
    );
  }
  if (appEnv === 'staging' || appEnv === 'production') {
    if (browser.protocol !== 'https:')
      throw new EnvironmentValidationError('BOARD_ALLOWED_ORIGINS', 'must use https');
  } else if (browser.protocol === 'http:' && !LOOPBACK_HOSTS.has(browser.hostname)) {
    throw new EnvironmentValidationError(
      'BOARD_ALLOWED_ORIGINS',
      'http is limited to a shared loopback host',
    );
  }

  const persistence = parsePersistenceEnvironment(input);

  return {
    appEnv,
    nodeEnv,
    port: parseInteger(input, 'PORT', 1, 65_535),
    ...persistence,
    gmail: {
      user: parseGmailUser(input),
      appPassword: parseBoundedText(input, 'SCENEBOARD_GMAIL_APP_PASSWORD', 8, 128),
    },
    keys: {
      sessionToken: parseKey(input, 'SESSION_TOKEN_KEY_B64'),
      grantToken: parseKey(input, 'GRANT_TOKEN_KEY_B64'),
      csrf: parseKey(input, 'CSRF_KEY_B64'),
      pairingCodePepper: parseKey(input, 'PAIRING_CODE_PEPPER_B64'),
      auditHmac: parseKey(input, 'AUDIT_HMAC_KEY_B64'),
      rateLimitHmac: parseKey(input, 'RATE_LIMIT_HMAC_KEY_B64'),
    },
    cursorMacKey: createCursorMacKeyV1(parseKey(input, 'BOARD_CURSOR_MAC_KEY_B64')),
    streamKeyMaterial: parseStreamKey(input),
    bcryptCost: parseInteger(input, 'BCRYPT_COST', 10, 14),
    authFailureMinMs: parseInteger(input, 'AUTH_FAILURE_MIN_MS', 200, 2_000),
    authFailureJitterMs: parseInteger(input, 'AUTH_FAILURE_JITTER_MS', 10, 25),
    pairingFailureMinMs: parseInteger(input, 'PAIRING_FAILURE_MIN_MS', 50, 2_000),
    pairingFailureJitterMs: parseInteger(input, 'PAIRING_FAILURE_JITTER_MS', 10, 25),
    browserOrigin: browser.value,
    publicApiOrigin: api.value,
    trustedProxyCidrs: parseTrustedProxyCidrs(input),
    revisionRetentionCount: parseOptionalInteger(
      input,
      'REVISION_RETENTION_COUNT',
      REVISION_RETENTION_DEFAULT,
      REVISION_RETENTION_MINIMUM,
      REVISION_RETENTION_MAXIMUM,
    ),
    historyRetainedEmissionEnabled: parseOptionalBoolean(
      input,
      'HISTORY_RETAINED_EMISSION_ENABLED',
      false,
    ),
    revisionReclamationEnabled: parseOptionalBoolean(input, 'REVISION_RECLAMATION_ENABLED', false),
    accountApiKeyIssuanceEnabled: parseOptionalBoolean(
      input,
      'ACCOUNT_API_KEY_ISSUANCE_ENABLED',
      false,
    ),
    accountApiKeyAuthEnabled: parseOptionalBoolean(input, 'ACCOUNT_API_KEY_AUTH_ENABLED', false),
    boardDocumentV3WriteEnabled: parseOptionalBoolean(
      input,
      'BOARD_DOCUMENT_V3_WRITE_ENABLED',
      false,
    ),
  };
};
