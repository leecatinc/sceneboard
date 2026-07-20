import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const API_DEFAULT = 'https://sceneboard.dev';
const MAX_CONFIG_BYTES = 65_536;
const SUCCESS_BODY_LIMIT = 2_097_152;
const ERROR_BODY_LIMIT = 65_536;
const TOKEN_PATTERN = /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GLOBAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const PAIRING_CODE_PATTERN = /^(?:SB-)?[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WINDOWS_PROTECTED_VALUE_PATTERN = /^[A-Za-z0-9+/]{16,8192}={0,2}$/;
const WINDOWS_PROTECTION = 'windows-dpapi-current-user';
const WINDOWS_DPAPI_TIMEOUT_MS = 10_000;
const WINDOWS_DPAPI_OUTPUT_LIMIT = 16_384;
const WINDOWS_DPAPI_SCRIPTS = {
  protect: '$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))',
  unprotect: '$value=[Console]::In.ReadToEnd();$protected=[Convert]::FromBase64String($value);$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
};
const NODE_TYPES = [
  'layout.split', 'layout.grid', 'layout.tabs', 'layout.canvas',
  'content.markdown', 'content.code', 'content.table', 'content.chart', 'content.map',
  'content.drawing', 'content.status', 'content.image', 'content.progress', 'content.hitl', 'content.artifact',
];
const COMMAND_TYPES = [
  'scene.replace', 'scene.clear', 'scene.restore', 'hitl.request', 'hitl.respond', 'artifact.publish', 'artifact.stop',
];
const OPERATION_TYPES = [
  'board.list', 'board.get', 'board.create', 'board.archive', 'capabilities.get',
  'history.list', 'history.get', 'artifact.get', 'hitl.read',
];
const EVENT_TYPES = [
  'board.snapshot', 'board.revision.created', 'hitl.updated', 'artifact.status.changed',
  'presence.updated', 'stream.resync.required', 'stream.heartbeat', 'stream.error',
];
const HITL_KINDS = ['info', 'choice', 'form', 'confirmation'];
const CAPABILITY_SCOPES = [
  'artifact.control', 'artifact.publish', 'board.history.read', 'board.hitl.request',
  'board.hitl.respond', 'board.read', 'board.write',
];
const GRANT_SCOPES = [
  'board.read', 'board.write', 'board.history.read', 'board.hitl.request',
  'board.hitl.respond', 'artifact.publish', 'artifact.control',
];
const LIFECYCLE_PERMISSIONS = ['board.create', 'board.archive'];
const ARTIFACT_CAPABILITIES = ['clipboard.write', 'download', 'fullscreen', 'network.fetch'];
const BOARD_LIMITS = {
  maxEnvelopeBytes: 1_048_576,
  maxSceneBytes: 786_432,
  maxSceneDepth: 12,
  maxSceneNodes: 500,
  maxJsonDepth: 64,
  maxJsonContainerEntries: 10_000,
  maxSplitChildren: 12,
  maxGridColumns: 24,
  maxGridRows: 100,
  maxGridItems: 200,
  maxTabs: 20,
  maxCanvasItems: 200,
  maxCanvasExtent: 100_000,
  maxTitleChars: 200,
  maxImageAltChars: 500,
  maxMarkdownChars: 100_000,
  maxCodeChars: 200_000,
  maxTableColumns: 50,
  maxTableRows: 500,
  maxTableCells: 10_000,
  maxChartSeries: 32,
  maxChartPoints: 10_000,
  maxMapFeatures: 5_000,
  maxDrawingElements: 5_000,
  maxArtifactResources: 128,
  maxArtifactResourceBytes: 5_242_880,
  maxArtifactTotalBytes: 10_485_760,
  maxBoardArtifacts: 100,
  maxBoardArtifactVersions: 1_000,
  maxBoardArtifactResourceRows: 10_000,
  maxBoardArtifactChargedBytes: 536_870_912,
  maxHitlOptions: 50,
  maxHitlFields: 50,
  maxHitlTextChars: 60_000,
  maxHitlResponseBytes: 65_536,
  maxPageSize: 100,
  maxPageCursorChars: 512,
  maxHitlWaitMs: 30_000,
};
const CONNECTION_VERSIONS = { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' };
const PAIRING_STATES = ['pending', 'approved', 'redeemed', 'denied', 'cancelled', 'expired'];
const PAIRING_ERROR_STATUS = {
  INVALID_PAYLOAD: 400,
  PAIRING_UNAVAILABLE: 400,
  PAIRING_PROOF_INVALID: 401,
  PAIRING_NOT_READY: 409,
  PAIRING_TERMINAL: 410,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};
const BOARD_ERROR_STATUS = {
  INVALID_PAYLOAD: 400,
  PROTOCOL_VERSION_MISMATCH: 409,
  UNKNOWN_NODE_TYPE: 422,
  UNKNOWN_COMMAND_TYPE: 422,
  UNKNOWN_OPERATION_TYPE: 422,
  INVALID_LAYOUT: 422,
  DUPLICATE_NODE_ID: 422,
  LIMIT_EXCEEDED: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CAPABILITY_DENIED: 403,
  BOARD_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  HITL_REQUEST_NOT_FOUND: 404,
  BOARD_ALREADY_ARCHIVED: 409,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  HITL_REQUEST_ID_CONFLICT: 409,
  HITL_RESPONSE_CONFLICT: 409,
  HITL_REQUEST_EXPIRED: 410,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};
const RETRYABLE_BOARD_ERRORS = new Set(['RATE_LIMITED', 'SERVICE_UNAVAILABLE']);
const BOARD_ERROR_CATEGORIES = {
  INVALID_PAYLOAD: 'validation', PROTOCOL_VERSION_MISMATCH: 'protocol',
  UNKNOWN_NODE_TYPE: 'validation', UNKNOWN_COMMAND_TYPE: 'validation', UNKNOWN_OPERATION_TYPE: 'validation',
  INVALID_LAYOUT: 'validation', DUPLICATE_NODE_ID: 'validation', LIMIT_EXCEEDED: 'validation',
  PAYLOAD_TOO_LARGE: 'validation', UNAUTHENTICATED: 'auth', FORBIDDEN: 'auth', CAPABILITY_DENIED: 'auth',
  BOARD_NOT_FOUND: 'not_found', REVISION_NOT_FOUND: 'not_found', ARTIFACT_NOT_FOUND: 'not_found',
  HITL_REQUEST_NOT_FOUND: 'not_found', BOARD_ALREADY_ARCHIVED: 'conflict', REVISION_CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'conflict', HITL_REQUEST_ID_CONFLICT: 'conflict',
  HITL_RESPONSE_CONFLICT: 'conflict', HITL_REQUEST_EXPIRED: 'conflict', RATE_LIMITED: 'rate_limit',
  SERVICE_UNAVAILABLE: 'availability', INTERNAL_ERROR: 'internal',
};
const COMMON_ERRORS = ['INVALID_PAYLOAD', 'PROTOCOL_VERSION_MISMATCH', 'UNAUTHENTICATED', 'FORBIDDEN'];
const AVAILABILITY_ERRORS = ['RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR'];
const OPERATION_ERROR_CODES = {
  board_connection_status: ['INVALID_PAYLOAD', 'UNAUTHENTICATED', 'FORBIDDEN', 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_list: [...COMMON_ERRORS, ...AVAILABILITY_ERRORS],
  board_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_create: [...COMMON_ERRORS, 'IDEMPOTENCY_KEY_REUSED', ...AVAILABILITY_ERRORS],
  board_archive: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'BOARD_ALREADY_ARCHIVED', 'IDEMPOTENCY_KEY_REUSED', ...AVAILABILITY_ERRORS],
  board_capabilities_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_scene_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_scene_replace: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'UNKNOWN_NODE_TYPE', 'INVALID_LAYOUT', 'DUPLICATE_NODE_ID', 'LIMIT_EXCEEDED', 'PAYLOAD_TOO_LARGE', ...AVAILABILITY_ERRORS],
  board_scene_patch: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'UNKNOWN_NODE_TYPE', 'INVALID_LAYOUT', 'DUPLICATE_NODE_ID', 'LIMIT_EXCEEDED', 'PAYLOAD_TOO_LARGE', ...AVAILABILITY_ERRORS],
  board_scene_clear: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', ...AVAILABILITY_ERRORS],
  board_artifact_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'ARTIFACT_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_artifact_put: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'CAPABILITY_DENIED', 'LIMIT_EXCEEDED', 'PAYLOAD_TOO_LARGE', ...AVAILABILITY_ERRORS],
  board_artifact_stop: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'ARTIFACT_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_history_list: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_history_get: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_history_restore: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', ...AVAILABILITY_ERRORS],
  board_interaction_request: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'HITL_REQUEST_ID_CONFLICT', 'LIMIT_EXCEEDED', 'PAYLOAD_TOO_LARGE', ...AVAILABILITY_ERRORS],
  board_interaction_status: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'HITL_REQUEST_NOT_FOUND', ...AVAILABILITY_ERRORS],
  board_interaction_respond: [...COMMON_ERRORS, 'BOARD_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'HITL_REQUEST_NOT_FOUND', 'HITL_RESPONSE_CONFLICT', 'HITL_REQUEST_EXPIRED', 'PAYLOAD_TOO_LARGE', ...AVAILABILITY_ERRORS],
};
const PROJECT_ENV_KEYS = ['BOARD_ACCESS_TOKEN_REF', 'BOARD_API_URL', 'BOARD_PROFILE', 'BOARD_TIMEOUT_MS'];

export class SceneBoardApiError extends Error {
  constructor(code, message, { retryable = false, details = null, exitCode = 1 } = {}) {
    super(message);
    this.name = 'SceneBoardApiError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.exitCode = exitCode;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value, keys) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validTimestamp = (value) => {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const hasDuplicateJsonMember = (source) => {
  const keySets = [];
  const containers = [];
  let expectingKey = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === '"') break;
        else index += 1;
      }
      if (index >= source.length) return false;
      if (expectingKey && containers.at(-1) === 'object') {
        let key;
        try {
          key = JSON.parse(source.slice(start, index + 1));
        } catch {
          return false;
        }
        const keys = keySets.at(-1);
        if (typeof key !== 'string' || keys === undefined) return false;
        if (keys.has(key)) return true;
        keys.add(key);
        expectingKey = false;
      }
      continue;
    }
    if (character === '{') {
      containers.push('object');
      keySets.push(new Set());
      expectingKey = true;
    } else if (character === '[') containers.push('array');
    else if (character === '}' || character === ']') {
      const removed = containers.pop();
      if (removed === 'object') keySets.pop();
      expectingKey = false;
    } else if (character === ',' && containers.at(-1) === 'object') expectingKey = true;
    else if (character === ':' && containers.at(-1) === 'object') expectingKey = false;
  }
  return false;
};

const parseJsonBytes = (bytes, label, maximum = SUCCESS_BODY_LIMIT) => {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, { details: { reason: 'body_size' } });
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, { details: { reason: 'utf8' } });
  }
  if (hasDuplicateJsonMember(source)) {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, { details: { reason: 'duplicate_member' } });
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, { details: { reason: 'json' } });
  }
};

export const parseApiInputBytes = (bytes) => {
  try {
    return parseJsonBytes(bytes, 'SceneBoard API fallback input', 1_048_576);
  } catch {
    throw new SceneBoardApiError('INVALID_PAYLOAD', 'SceneBoard API fallback input is invalid JSON', { exitCode: 2 });
  }
};

const validateBaseUrl = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || /[<>${}\s]/u.test(value)) {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'baseUrl' } });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'baseUrl' } });
  }
  const isLoopback = ['127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.origin !== value || url.pathname !== '/' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))) {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'baseUrl' } });
  }
  return url.origin;
};

const validateProfile = (value) => {
  if (typeof value !== 'string' || !PROFILE_PATTERN.test(value)) {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'profile' } });
  }
  return value;
};

const validateTimeout = (value) => {
  const timeoutMs = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'timeoutMs' } });
  }
  return timeoutMs;
};

const isWindows = (platform) => platform === 'win32';

const runWindowsDataProtection = (operation, value) => new Promise((resolve, reject) => {
  const script = WINDOWS_DPAPI_SCRIPTS[operation];
  if (script === undefined || typeof value !== 'string') {
    reject(new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard Windows credential protection is unavailable'));
    return;
  }
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) {
    reject(new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard Windows credential protection is unavailable',
      { details: { reason: 'windows_system_root_unavailable' } },
    ));
    return;
  }
  const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let output = '';
  let outputBytes = 0;
  let settled = false;
  const child = spawn(powershellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const finish = (error, result = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error === null) resolve(result);
    else reject(new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard Windows credential protection is unavailable',
      { details: { reason: error } },
    ));
  };
  const timeout = setTimeout(() => {
    child.kill();
    finish('windows_dpapi_timeout');
  }, WINDOWS_DPAPI_TIMEOUT_MS);
  child.once('error', () => finish('windows_dpapi_process_unavailable'));
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > WINDOWS_DPAPI_OUTPUT_LIMIT) {
      child.kill();
      finish('windows_dpapi_output_too_large');
      return;
    }
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', () => {});
  child.once('close', (code) => {
    if (code !== 0) finish('windows_dpapi_failed');
    else if (output.length === 0) finish('windows_dpapi_empty_output');
    else finish(null, output);
  });
  child.stdin.once('error', () => finish('windows_dpapi_input_failed'));
  child.stdin.end(value);
});

const defaultWindowsDataProtection = {
  protect: (value) => runWindowsDataProtection('protect', value),
  unprotect: (value) => runWindowsDataProtection('unprotect', value),
};

const statRegularPrivateFile = async (path, platform = process.platform) => {
  const status = await lstat(path);
  const ownUid = process.geteuid?.();
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1
    || (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid)
    || (!isWindows(platform) && (status.mode & 0o777) !== 0o600)) {
    throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard private state is invalid');
  }
};

const assertPrivateDirectory = async (path, platform = process.platform) => {
  const status = await lstat(path);
  const ownUid = process.geteuid?.();
  if (!status.isDirectory() || status.isSymbolicLink()
    || (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid)
    || (!isWindows(platform) && (status.mode & 0o777) !== 0o700)) {
    throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard private state is invalid');
  }
};

const ensurePrivateDirectory = async (path, platform = process.platform) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  const ownUid = process.geteuid?.();
  if (!status.isDirectory() || status.isSymbolicLink()
    || (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid)) {
    throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard private state is invalid');
  }
  if (!isWindows(platform) && (status.mode & 0o777) !== 0o700) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  await assertPrivateDirectory(path, platform);
};

const syncDirectory = async (directory, platform = process.platform) => {
  if (isWindows(platform)) return;
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
};

const stateRoot = (env, platform = process.platform) => {
  if (isWindows(platform)) {
    const localAppData = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
    if (!isAbsolute(localAppData)) {
      throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'LOCALAPPDATA' } });
    }
    return localAppData;
  }
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== '') {
    if (!isAbsolute(env.XDG_STATE_HOME)) {
      throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'XDG_STATE_HOME' } });
    }
    return env.XDG_STATE_HOME;
  }
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) {
    throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'SceneBoard API configuration is invalid', { details: { field: 'HOME' } });
  }
  return join(home, '.local', 'state');
};

export const resolveApiConfig = async ({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  windowsDataProtection = defaultWindowsDataProtection,
} = {}) => {
  let source = 'production_default';
  let baseUrl = env.SCENEBOARD_API_URL ?? API_DEFAULT;
  let profile = env.SCENEBOARD_PROFILE ?? 'sceneboard';
  let timeoutMs = env.SCENEBOARD_TIMEOUT_MS ?? 30_000;
  const projectConfigPath = join(cwd, '.mcp.json');
  try {
    const status = await lstat(projectConfigPath);
    if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > MAX_CONFIG_BYTES) {
      throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'Project SceneBoard configuration is invalid');
    }
    const parsed = parseJsonBytes(await readFile(projectConfigPath), 'Project SceneBoard configuration', MAX_CONFIG_BYTES);
    const server = isRecord(parsed?.mcpServers) ? parsed.mcpServers.sceneboard : undefined;
    const selectedEnvironment = isRecord(server) && isRecord(server.env)
      && PROJECT_ENV_KEYS.some((key) => Object.hasOwn(server.env, key));
    if (selectedEnvironment) {
      if (!hasExactKeys(server.env, PROJECT_ENV_KEYS)) {
        throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'Project SceneBoard configuration is invalid');
      }
      baseUrl = server.env.BOARD_API_URL;
      profile = server.env.BOARD_PROFILE;
      timeoutMs = server.env.BOARD_TIMEOUT_MS;
      if (typeof profile !== 'string' || server.env.BOARD_ACCESS_TOKEN_REF !== `store://${profile}`) {
        throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'Project SceneBoard configuration is invalid');
      }
      source = 'project_mcp';
    } else {
      if (server !== undefined && (!isRecord(server) || !isRecord(server.env))) {
        throw new SceneBoardApiError('BOARD_API_CONFIG_INVALID', 'Project SceneBoard configuration is invalid');
      }
      if (env.SCENEBOARD_API_URL !== undefined || env.SCENEBOARD_PROFILE !== undefined
        || env.SCENEBOARD_TIMEOUT_MS !== undefined) source = 'environment';
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (env.SCENEBOARD_API_URL !== undefined || env.SCENEBOARD_PROFILE !== undefined
      || env.SCENEBOARD_TIMEOUT_MS !== undefined) source = 'environment';
  }
  const validProfile = validateProfile(profile);
  return {
    baseUrl: validateBaseUrl(baseUrl),
    profile: validProfile,
    timeoutMs: validateTimeout(timeoutMs),
    source,
    platform,
    windowsDataProtection,
    stateDirectory: join(stateRoot(env, platform), 'leecat-board', 'credentials', validProfile),
  };
};

export const atomicPrivateWrite = async (directory, fileName, bytes, { platform = process.platform } = {}) => {
  await ensurePrivateDirectory(directory, platform);
  const temporaryPath = join(directory, `.${fileName}.${randomBytes(16).toString('base64url')}.tmp`);
  const targetPath = join(directory, fileName);
  let handle = null;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | (isWindows(platform) ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    if (!isWindows(platform)) await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await statRegularPrivateFile(temporaryPath, platform);
    await rename(temporaryPath, targetPath);
    renamed = true;
    await syncDirectory(directory, platform);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
};

export const readCredential = async (config) => {
  const path = join(config.stateDirectory, 'credential.json');
  try {
    await ensurePrivateDirectory(config.stateDirectory, config.platform);
    await statRegularPrivateFile(path, config.platform);
    const bytes = await readFile(path);
    const record = parseJsonBytes(bytes, 'SceneBoard credential', 512);
    const source = new TextDecoder().decode(bytes);
    if (isWindows(config.platform)) {
      if (!hasExactKeys(record, ['version', 'generation', 'protection', 'protectedAccessToken']) || record.version !== 2
        || typeof record.generation !== 'string' || !GENERATION_PATTERN.test(record.generation)
        || record.protection !== WINDOWS_PROTECTION
        || typeof record.protectedAccessToken !== 'string'
        || !WINDOWS_PROTECTED_VALUE_PATTERN.test(record.protectedAccessToken)
        || JSON.stringify(record) !== source) {
        throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard credential is invalid');
      }
      let accessToken;
      try {
        accessToken = await config.windowsDataProtection.unprotect(record.protectedAccessToken);
      } catch (error) {
        if (error instanceof SceneBoardApiError) throw error;
        throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard Windows credential protection is unavailable');
      }
      if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken)) {
        throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard credential is invalid');
      }
      return { version: 1, generation: record.generation, accessToken };
    }
    if (!hasExactKeys(record, ['version', 'generation', 'accessToken']) || record.version !== 1
      || typeof record.generation !== 'string' || !GENERATION_PATTERN.test(record.generation)
      || typeof record.accessToken !== 'string' || !TOKEN_PATTERN.test(record.accessToken)
      || JSON.stringify(record) !== source) {
      throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard credential is invalid');
    }
    return record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const acquireCredentialMutationLock = async (config) => {
  await ensurePrivateDirectory(config.stateDirectory, config.platform);
  const path = join(config.stateDirectory, 'api-credential.lock');
  const nonce = randomBytes(16).toString('base64url');
  let handle = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | (isWindows(config.platform) ? 0 : constants.O_NOFOLLOW), 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === 39) {
        throw new SceneBoardApiError('BOARD_API_PROFILE_BUSY', 'SceneBoard credential profile is busy', {
          retryable: true,
          details: { recovery: 'retry_after_current_credential_update' },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    if (!isWindows(config.platform)) await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ version: 1, nonce }));
    await handle.sync();
    await handle.close();
    handle = null;
    await statRegularPrivateFile(path, config.platform);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return async () => {
    try {
      await ensurePrivateDirectory(config.stateDirectory, config.platform);
      await statRegularPrivateFile(path, config.platform);
      const value = parseJsonBytes(await readFile(path), 'SceneBoard credential lock', 256);
      if (hasExactKeys(value, ['version', 'nonce']) && value.version === 1 && value.nonce === nonce) {
        await unlink(path);
        await syncDirectory(config.stateDirectory, config.platform);
      }
    } catch {}
  };
};

export const writeCredential = async (config, accessToken) => {
  if (!TOKEN_PATTERN.test(accessToken)) {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard pairing response is invalid');
  }
  const generation = randomBytes(16).toString('base64url');
  let record;
  if (isWindows(config.platform)) {
    let protectedAccessToken;
    try {
      protectedAccessToken = await config.windowsDataProtection.protect(accessToken);
    } catch (error) {
      if (error instanceof SceneBoardApiError) throw error;
      throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard Windows credential protection is unavailable');
    }
    if (typeof protectedAccessToken !== 'string' || !WINDOWS_PROTECTED_VALUE_PATTERN.test(protectedAccessToken)) {
      throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard Windows credential protection is unavailable');
    }
    record = { version: 2, generation, protection: WINDOWS_PROTECTION, protectedAccessToken };
  } else record = { version: 1, generation, accessToken };
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const release = await acquireCredentialMutationLock(config);
  try {
    await atomicPrivateWrite(config.stateDirectory, 'credential.json', bytes, { platform: config.platform });
  } finally {
    bytes.fill(0);
    await release();
  }
  return generation;
};

export const deleteCredentialIfGeneration = async (config, generation) => {
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) return false;
  const release = await acquireCredentialMutationLock(config);
  const path = join(config.stateDirectory, 'credential.json');
  try {
    await ensurePrivateDirectory(config.stateDirectory, config.platform);
    await statRegularPrivateFile(path, config.platform);
    const current = await readCredential(config);
    if (current === null || current.generation !== generation) return false;
    const quarantine = join(config.stateDirectory, `.credential.quarantine.${randomBytes(16).toString('base64url')}`);
    await rename(path, quarantine);
    await syncDirectory(config.stateDirectory, config.platform);
    await unlink(quarantine).catch(() => undefined);
    await syncDirectory(config.stateDirectory, config.platform);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    await release();
  }
};

export const getOrCreateInstallationId = async (config) => {
  const path = join(config.stateDirectory, 'installation.json');
  try {
    await ensurePrivateDirectory(config.stateDirectory, config.platform);
    await statRegularPrivateFile(path, config.platform);
    const bytes = await readFile(path);
    const record = parseJsonBytes(bytes, 'SceneBoard installation', 256);
    if (!hasExactKeys(record, ['version', 'installationId']) || record.version !== 1
      || typeof record.installationId !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/u.test(record.installationId)
      || JSON.stringify(record) !== new TextDecoder().decode(bytes)) {
      throw new SceneBoardApiError('BOARD_API_CREDENTIAL_UNAVAILABLE', 'SceneBoard installation identity is invalid');
    }
    return record.installationId;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const installationId = `install_${randomBytes(24).toString('base64url')}`;
  await atomicPrivateWrite(
    config.stateDirectory,
    'installation.json',
    new TextEncoder().encode(JSON.stringify({ version: 1, installationId })),
    { platform: config.platform },
  );
  return installationId;
};

export const acquirePairingLock = async (config) => {
  await ensurePrivateDirectory(config.stateDirectory, config.platform);
  const path = join(config.stateDirectory, 'api-pairing.lock');
  const nonce = randomBytes(16).toString('base64url');
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (isWindows(config.platform) ? 0 : constants.O_NOFOLLOW), 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new SceneBoardApiError('BOARD_API_PROFILE_BUSY', 'SceneBoard API fallback pairing is already active', {
        retryable: true,
        details: { recovery: 'finish_or_stop_existing_api_pairing' },
      });
    }
    throw error;
  }
  try {
    if (!isWindows(config.platform)) await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ version: 1, nonce }));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return async () => {
    try {
      await statRegularPrivateFile(path, config.platform);
      const value = parseJsonBytes(await readFile(path), 'SceneBoard pairing lock', 256);
      if (value?.version === 1 && value?.nonce === nonce) await unlink(path);
    } catch {}
  };
};

const readBoundedBody = async (response, maximum, signal) => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
          details: { reason: 'body_too_large' },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const sleep = (milliseconds, signal) => new Promise((resolve) => {
  let finished = false;
  const done = (completed) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    resolve(completed);
  };
  const onAbort = () => done(false);
  const timer = setTimeout(() => done(true), milliseconds);
  if (signal?.aborted) done(false);
  else signal?.addEventListener('abort', onAbort, { once: true });
});

const safeText = (value, maximum = 200) => typeof value === 'string' && [...value].length >= 1
  && [...value].length <= maximum && !/[\uD800-\uDFFF]/u.test(value);

const validClientName = (value) => safeText(value, 100) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  && !containsSecretValue(value);

const containsSecretValue = (value) => /\blcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/u.test(value)
  || /\b(?:Bearer|PairingProof)\s+[A-Za-z0-9._-]{16,}\b/iu.test(value)
  || /\b[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}\b/iu.test(value);

const SENSITIVE_CONTEXT_PATTERN = /(authorization|token|proof|challenge|password|cookie|secret|generation)/iu;
const isSecretShaped = (value) => typeof value === 'string' && (TOKEN_PATTERN.test(value)
  || PROOF_PATTERN.test(value) || GENERATION_PATTERN.test(value) || containsSecretValue(value));
const hasContextualSecret = (contexts, values) => contexts.some((context) => (
  typeof context === 'string' && SENSITIVE_CONTEXT_PATTERN.test(context)
)) && values.some(isSecretShaped);

const sanitizePublicValue = (value, depth = 0, budget = { count: 0 }) => {
  budget.count += 1;
  if (budget.count > 1_000 || depth > 8) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if ([...value].length > 512 || containsSecretValue(value)
      || isAbsolute(value) || /^[A-Za-z]:\\/u.test(value)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizePublicValue(item, depth + 1, budget));
  if (!isRecord(value)) return null;
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_CONTEXT_PATTERN.test(key)) {
      output[key] = '[redacted]';
    } else output[key] = sanitizePublicValue(child, depth + 1, budget);
  }
  return output;
};

const validGlobalId = (value) => typeof value === 'string' && GLOBAL_ID_PATTERN.test(value);
const validLocalId = (value) => typeof value === 'string' && LOCAL_ID_PATTERN.test(value);
const validPublicString = (value) => typeof value === 'string' && !containsSecretValue(value);
const validErrorPath = (value) => Array.isArray(value) && value.every((part) => (
  validPublicString(part) || (Number.isInteger(part) && part >= 0)
));
const validArtifactReference = (value) => hasExactKeys(value, ['artifactId', 'versionId'])
  && validGlobalId(value.artifactId) && validGlobalId(value.versionId);
const projectBoardErrorDetails = (code, value) => {
  if (['UNAUTHENTICATED', 'FORBIDDEN', 'BOARD_NOT_FOUND', 'INTERNAL_ERROR'].includes(code)) {
    return value === null ? null : undefined;
  }
  if (code === 'INVALID_PAYLOAD') {
    return hasExactKeys(value, ['path', 'issue']) && validErrorPath(value.path) && safeText(value.issue)
      && !containsSecretValue(value.issue) ? { path: [...value.path], issue: value.issue } : undefined;
  }
  if (code === 'PROTOCOL_VERSION_MISMATCH') {
    return hasExactKeys(value, ['reason', 'supportedMajor', 'receivedMajor', 'field'])
      && ['major', 'schema_revision', 'catalog', 'limit'].includes(value.reason) && value.supportedMajor === 1
      && (value.receivedMajor === null || (Number.isInteger(value.receivedMajor) && value.receivedMajor >= 0))
      && (value.field === null || validPublicString(value.field))
      ? { reason: value.reason, supportedMajor: 1, receivedMajor: value.receivedMajor, field: value.field } : undefined;
  }
  if (['UNKNOWN_NODE_TYPE', 'UNKNOWN_COMMAND_TYPE', 'UNKNOWN_OPERATION_TYPE'].includes(code)) {
    return hasExactKeys(value, ['path', 'receivedType']) && validErrorPath(value.path)
      && validPublicString(value.receivedType)
      ? { path: [...value.path], receivedType: value.receivedType } : undefined;
  }
  if (code === 'INVALID_LAYOUT') {
    return hasExactKeys(value, ['path', 'reason']) && validErrorPath(value.path)
      && ['bounds', 'overlap', 'reference', 'geometry'].includes(value.reason)
      ? { path: [...value.path], reason: value.reason } : undefined;
  }
  if (code === 'DUPLICATE_NODE_ID') {
    return hasExactKeys(value, ['nodeId', 'firstPath', 'duplicatePath']) && validLocalId(value.nodeId)
      && validErrorPath(value.firstPath) && validErrorPath(value.duplicatePath)
      ? { nodeId: value.nodeId, firstPath: [...value.firstPath], duplicatePath: [...value.duplicatePath] } : undefined;
  }
  if (code === 'LIMIT_EXCEEDED') {
    return hasExactKeys(value, ['limit', 'actual', 'maximum', 'path']) && Object.hasOwn(BOARD_LIMITS, value.limit)
      && typeof value.actual === 'number' && Number.isFinite(value.actual) && value.actual >= 0
      && typeof value.maximum === 'number' && Number.isFinite(value.maximum) && value.maximum >= 0
      && validErrorPath(value.path)
      ? { limit: value.limit, actual: value.actual, maximum: value.maximum, path: [...value.path] } : undefined;
  }
  if (code === 'PAYLOAD_TOO_LARGE') {
    return hasExactKeys(value, ['scope', 'actualBytes', 'maximumBytes'])
      && ['envelope', 'scene', 'hitl.response', 'artifact.resource', 'artifact.total'].includes(value.scope)
      && Number.isSafeInteger(value.actualBytes) && value.actualBytes >= 0
      && Number.isSafeInteger(value.maximumBytes) && value.maximumBytes > 0
      ? { scope: value.scope, actualBytes: value.actualBytes, maximumBytes: value.maximumBytes } : undefined;
  }
  if (code === 'CAPABILITY_DENIED') {
    return hasExactKeys(value, ['capability']) && [...GRANT_SCOPES, ...ARTIFACT_CAPABILITIES].includes(value.capability)
      ? { capability: value.capability } : undefined;
  }
  if (code === 'REVISION_NOT_FOUND') return hasExactKeys(value, ['revisionId']) && validGlobalId(value.revisionId) ? { revisionId: value.revisionId } : undefined;
  if (code === 'ARTIFACT_NOT_FOUND') return hasExactKeys(value, ['artifact']) && validArtifactReference(value.artifact) ? { artifact: { ...value.artifact } } : undefined;
  if (code === 'HITL_REQUEST_NOT_FOUND' || code === 'HITL_REQUEST_ID_CONFLICT') {
    return hasExactKeys(value, ['hitlRequestId']) && validGlobalId(value.hitlRequestId) ? { hitlRequestId: value.hitlRequestId } : undefined;
  }
  if (code === 'BOARD_ALREADY_ARCHIVED') {
    return hasExactKeys(value, ['boardId', 'archivedAt']) && validGlobalId(value.boardId) && validTimestamp(value.archivedAt)
      ? { boardId: value.boardId, archivedAt: value.archivedAt } : undefined;
  }
  if (code === 'REVISION_CONFLICT') {
    return hasExactKeys(value, ['boardId', 'expectedRevisionId', 'actualRevisionId', 'actualRevisionNumber', 'recovery'])
      && validGlobalId(value.boardId) && validGlobalId(value.expectedRevisionId) && validGlobalId(value.actualRevisionId)
      && Number.isSafeInteger(value.actualRevisionNumber) && value.actualRevisionNumber > 0
      && value.recovery === 'fetch_latest_then_retry'
      ? { boardId: value.boardId, expectedRevisionId: value.expectedRevisionId, actualRevisionId: value.actualRevisionId,
        actualRevisionNumber: value.actualRevisionNumber, recovery: value.recovery } : undefined;
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    if (!hasExactKeys(value, ['scope', 'boardId', 'operationType', 'reason'])) return undefined;
    const variants = {
      'board.mutation': { boardRequired: true, operations: COMMAND_TYPES, reasons: ['grant_changed', 'scopes_changed', 'expected_revision_changed', 'payload_changed'] },
      'board.create': { boardRequired: false, operations: ['board.create'], reasons: ['grant_changed', 'scopes_changed', 'title_changed'] },
      'board.archive': { boardRequired: true, operations: ['board.archive'], reasons: ['grant_changed', 'scopes_changed'] },
    };
    const variant = variants[value.scope];
    if (variant === undefined || (variant.boardRequired ? !validGlobalId(value.boardId) : value.boardId !== null)
      || !variant.operations.includes(value.operationType) || !variant.reasons.includes(value.reason)) return undefined;
    return { scope: value.scope, boardId: value.boardId, operationType: value.operationType, reason: value.reason };
  }
  if (code === 'HITL_RESPONSE_CONFLICT') {
    return hasExactKeys(value, ['hitlRequestId', 'state']) && validGlobalId(value.hitlRequestId)
      && ['answered', 'superseded', 'cancelled'].includes(value.state)
      ? { hitlRequestId: value.hitlRequestId, state: value.state } : undefined;
  }
  if (code === 'HITL_REQUEST_EXPIRED') {
    return hasExactKeys(value, ['hitlRequestId', 'expiredAt']) && validGlobalId(value.hitlRequestId) && validTimestamp(value.expiredAt)
      ? { hitlRequestId: value.hitlRequestId, expiredAt: value.expiredAt } : undefined;
  }
  if (code === 'RATE_LIMITED') {
    return hasExactKeys(value, ['retryAfterSeconds']) && typeof value.retryAfterSeconds === 'number'
      && Number.isFinite(value.retryAfterSeconds) && value.retryAfterSeconds > 0
      ? { retryAfterSeconds: value.retryAfterSeconds } : undefined;
  }
  if (code === 'SERVICE_UNAVAILABLE') {
    return hasExactKeys(value, ['retryAfterSeconds'])
      && (value.retryAfterSeconds === null || (typeof value.retryAfterSeconds === 'number'
        && Number.isFinite(value.retryAfterSeconds) && value.retryAfterSeconds > 0))
      ? { retryAfterSeconds: value.retryAfterSeconds } : undefined;
  }
  return undefined;
};

const parseRetryAfter = (response) => {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  if (!/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/u.test(value)) return 'invalid';
  return Number(value);
};

const errorFromResponse = (body, response, pairing, allowedErrorCodes) => {
  if (!hasExactKeys(body, ['error']) || !isRecord(body.error)) {
    return new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
      details: { reason: 'status', status: response.status },
    });
  }
  const error = body.error;
  if (pairing) {
    const expectedStatus = PAIRING_ERROR_STATUS[error.code];
    const retryAfter = parseRetryAfter(response);
    const requiresRetryAfter = ['PAIRING_NOT_READY', 'RATE_LIMITED'].includes(error.code);
    if (!hasExactKeys(error, ['code', 'message']) || expectedStatus !== response.status
      || !safeText(error.message) || retryAfter === 'invalid' || requiresRetryAfter !== (retryAfter !== null)) {
      return new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard pairing response is invalid', {
        details: { reason: 'status' },
      });
    }
    return new SceneBoardApiError(error.code, `SceneBoard pairing failed: ${error.code}`, {
      retryable: ['RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(error.code),
      details: retryAfter === null ? null : { retryAfterSeconds: retryAfter },
    });
  }
  const expectedStatus = BOARD_ERROR_STATUS[error.code];
  const projectedDetails = projectBoardErrorDetails(error.code, error.details);
  if (!hasExactKeys(error, ['protocolVersion', 'type', 'code', 'message', 'category', 'retryable', 'httpStatusHint', 'details'])
    || error.protocolVersion !== 1 || error.type !== 'board.error' || expectedStatus !== response.status
    || error.httpStatusHint !== response.status || error.retryable !== RETRYABLE_BOARD_ERRORS.has(error.code)
    || error.category !== BOARD_ERROR_CATEGORIES[error.code] || !allowedErrorCodes?.includes(error.code)
    || !safeText(error.message) || containsSecretValue(error.message) || projectedDetails === undefined) {
    return new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
      details: { reason: 'status', status: response.status },
    });
  }
  return new SceneBoardApiError(error.code, `SceneBoard request failed: ${error.code}`, {
    retryable: error.retryable,
    details: projectedDetails,
  });
};

const exactCatalog = (value, catalog, minimum = 0) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > catalog.length) return null;
  let previous = -1;
  for (const item of value) {
    const index = catalog.indexOf(item);
    if (index <= previous) return null;
    previous = index;
  }
  return [...value];
};

const fullCatalog = (value, catalog) => Array.isArray(value) && value.length === catalog.length
  && value.every((item, index) => item === catalog[index]) ? [...value] : null;

const parseCapabilities = (value) => {
  if (!hasExactKeys(value, ['protocolVersion', 'type', 'schemaVersion', 'compatibilityMode', 'supported', 'limits', 'grantedCapabilities', 'allowedArtifactRequestCapabilities'])
    || value.protocolVersion !== 1 || value.type !== 'board.capabilities' || value.schemaVersion !== '1.0.0'
    || value.compatibilityMode !== 'frozen-major'
    || !hasExactKeys(value.supported, ['nodeTypes', 'commandTypes', 'operationTypes', 'eventTypes', 'hitlKinds', 'artifactRequestCapabilities'])
    || fullCatalog(value.supported.nodeTypes, NODE_TYPES) === null
    || fullCatalog(value.supported.commandTypes, COMMAND_TYPES) === null
    || fullCatalog(value.supported.operationTypes, OPERATION_TYPES) === null
    || fullCatalog(value.supported.eventTypes, EVENT_TYPES) === null
    || fullCatalog(value.supported.hitlKinds, HITL_KINDS) === null
    || fullCatalog(value.supported.artifactRequestCapabilities, ARTIFACT_CAPABILITIES) === null
    || !hasExactKeys(value.limits, Object.keys(BOARD_LIMITS))
    || Object.entries(BOARD_LIMITS).some(([key, expected]) => value.limits[key] !== expected)) return null;
  const grantedCapabilities = exactCatalog(value.grantedCapabilities, CAPABILITY_SCOPES);
  const allowedArtifactRequestCapabilities = exactCatalog(value.allowedArtifactRequestCapabilities, ARTIFACT_CAPABILITIES);
  if (grantedCapabilities === null || allowedArtifactRequestCapabilities === null) return null;
  return {
    protocolVersion: 1,
    type: 'board.capabilities',
    schemaVersion: '1.0.0',
    compatibilityMode: 'frozen-major',
    supported: {
      nodeTypes: [...NODE_TYPES], commandTypes: [...COMMAND_TYPES], operationTypes: [...OPERATION_TYPES],
      eventTypes: [...EVENT_TYPES], hitlKinds: [...HITL_KINDS], artifactRequestCapabilities: [...ARTIFACT_CAPABILITIES],
    },
    limits: { ...BOARD_LIMITS },
    grantedCapabilities,
    allowedArtifactRequestCapabilities,
  };
};

const parseConnection = (value, boardId) => {
  if (!hasExactKeys(value, ['principal', 'grant', 'selectedBoard', 'versions'])
    || !hasExactKeys(value.principal, ['principalKind', 'principalId', 'grantId'])
    || !hasExactKeys(value.grant, ['grantId', 'client', 'scopes', 'lifecyclePermissions', 'boardIds', 'lifetime', 'status', 'activatedAt', 'expiresAt'])
    || !hasExactKeys(value.grant.client, ['clientId', 'clientName', 'installationFingerprint'])
    || !hasExactKeys(value.versions, ['mcpServer', 'boardProtocol', 'api'])) return null;
  const { principal, grant, versions } = value;
  const client = grant.client;
  const scopes = exactCatalog(grant.scopes, GRANT_SCOPES, 1);
  const lifecyclePermissions = exactCatalog(grant.lifecyclePermissions, LIFECYCLE_PERMISSIONS);
  if (principal.principalKind !== 'mcp_client' || !validGlobalId(principal.principalId)
    || !validGlobalId(principal.grantId) || principal.principalId !== client.clientId
    || principal.grantId !== grant.grantId || !validGlobalId(grant.grantId)
    || !validGlobalId(client.clientId) || !validClientName(client.clientName)
    || typeof client.installationFingerprint !== 'string' || !/^[A-Za-z0-9_-]{16}$/u.test(client.installationFingerprint)
    || scopes === null || lifecyclePermissions === null || !Array.isArray(grant.boardIds)
    || grant.boardIds.length > 50
    || (grant.boardIds.length === 0 && (!scopes.includes('board.write') || !lifecyclePermissions.includes('board.create')))
    || grant.boardIds.some((id) => !validGlobalId(id))
    || new Set(grant.boardIds).size !== grant.boardIds.length || !['session', 'persistent'].includes(grant.lifetime)
    || grant.status !== 'active' || !validTimestamp(grant.activatedAt) || !validTimestamp(grant.expiresAt)
    || typeof versions.mcpServer !== 'string' || !SEMVER_PATTERN.test(versions.mcpServer)
    || versions.boardProtocol !== CONNECTION_VERSIONS.boardProtocol || versions.api !== CONNECTION_VERSIONS.api) return null;
  if (boardId === null && value.selectedBoard !== null) return null;
  let selectedBoard = null;
  if (boardId !== null) {
    const selected = value.selectedBoard;
    const capabilities = parseCapabilities(selected?.capabilities);
    if (!hasExactKeys(selected, ['board', 'capabilities', 'browserPresence'])
      || !hasExactKeys(selected.board, ['boardId', 'title', 'createdAt', 'updatedAt', 'archivedAt', 'headRevision'])
      || !hasExactKeys(selected.board.headRevision, ['revisionId', 'revisionNumber', 'createdAt'])
      || selected.board.boardId !== boardId || !grant.boardIds.includes(boardId)
      || !safeText(selected.board.title) || containsSecretValue(selected.board.title)
      || !validTimestamp(selected.board.createdAt) || !validTimestamp(selected.board.updatedAt)
      || (selected.board.archivedAt !== null && !validTimestamp(selected.board.archivedAt))
      || !validGlobalId(selected.board.headRevision.revisionId)
      || !Number.isSafeInteger(selected.board.headRevision.revisionNumber) || selected.board.headRevision.revisionNumber < 1
      || !validTimestamp(selected.board.headRevision.createdAt) || !['online', 'offline', 'unknown'].includes(selected.browserPresence)
      || capabilities === null) return null;
    selectedBoard = {
      board: {
        boardId: selected.board.boardId,
        title: selected.board.title,
        createdAt: selected.board.createdAt,
        updatedAt: selected.board.updatedAt,
        archivedAt: selected.board.archivedAt,
        headRevision: { ...selected.board.headRevision },
      },
      capabilities,
      browserPresence: selected.browserPresence,
    };
  }
  return {
    principal: { principalKind: 'mcp_client', principalId: principal.principalId, grantId: principal.grantId },
    grant: {
      grantId: grant.grantId,
      client: { clientId: client.clientId, clientName: client.clientName, installationFingerprint: client.installationFingerprint },
      scopes,
      lifecyclePermissions,
      boardIds: [...grant.boardIds],
      lifetime: grant.lifetime,
      status: 'active',
      activatedAt: grant.activatedAt,
      expiresAt: grant.expiresAt,
    },
    selectedBoard,
    versions: { mcpServer: versions.mcpServer, boardProtocol: CONNECTION_VERSIONS.boardProtocol, api: CONNECTION_VERSIONS.api },
  };
};

const publicJsonTree = (value, depth = 0, budget = { count: 0 }, inheritedSensitiveContext = false) => {
  budget.count += 1;
  if (budget.count > 10_000 || depth > 64) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return !(inheritedSensitiveContext && isSecretShaped(value))
    && !containsSecretValue(value) && !/[\uD800-\uDFFF]/u.test(value);
  if (Array.isArray(value)) {
    return value.every((item) => publicJsonTree(item, depth + 1, budget, inheritedSensitiveContext));
  }
  return isRecord(value) && Object.entries(value).every(([key, item]) => {
    const sensitiveContext = inheritedSensitiveContext || SENSITIVE_CONTEXT_PATTERN.test(key);
    return !(sensitiveContext && isSecretShaped(item))
      && publicJsonTree(item, depth + 1, budget, sensitiveContext);
  });
};

const projectRevisionSummary = (value) => hasExactKeys(value, ['revisionId', 'revisionNumber', 'createdAt'])
  && validGlobalId(value.revisionId) && Number.isSafeInteger(value.revisionNumber) && value.revisionNumber > 0
  && validTimestamp(value.createdAt)
  ? { revisionId: value.revisionId, revisionNumber: value.revisionNumber, createdAt: value.createdAt } : null;

const projectBoardSummary = (value) => {
  const headRevision = projectRevisionSummary(value?.headRevision);
  if (!hasExactKeys(value, ['boardId', 'title', 'createdAt', 'updatedAt', 'archivedAt', 'headRevision'])
    || !validGlobalId(value.boardId) || !safeText(value.title) || containsSecretValue(value.title)
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || (value.archivedAt !== null && !validTimestamp(value.archivedAt)) || headRevision === null) return null;
  return { boardId: value.boardId, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt,
    archivedAt: value.archivedAt, headRevision };
};

const projectActor = (value) => hasExactKeys(value, ['principalKind', 'principalId'])
  && ['user', 'mcp_client', 'service'].includes(value.principalKind) && validGlobalId(value.principalId)
  ? { principalKind: value.principalKind, principalId: value.principalId } : null;

const projectSnapshotRevision = (value) => {
  const actor = projectActor(value?.actor);
  if (actor === null || !hasExactKeys(value, ['revisionId', 'revisionNumber', 'createdAt', 'previousRevisionId', 'originType', 'sourceRevisionId', 'actor'])
    || !validGlobalId(value.revisionId) || !Number.isSafeInteger(value.revisionNumber) || value.revisionNumber < 1
    || !validTimestamp(value.createdAt)
    || (value.previousRevisionId !== null && !validGlobalId(value.previousRevisionId))
    || !['board.create', 'scene.replace', 'scene.clear', 'scene.restore'].includes(value.originType)
    || (value.sourceRevisionId !== null && !validGlobalId(value.sourceRevisionId))) return null;
  return { revisionId: value.revisionId, revisionNumber: value.revisionNumber, createdAt: value.createdAt,
    previousRevisionId: value.previousRevisionId, originType: value.originType,
    sourceRevisionId: value.sourceRevisionId, actor };
};

const projectArtifactReference = (value) => validArtifactReference(value) ? { artifactId: value.artifactId, versionId: value.versionId } : null;

const projectArtifactRuntime = (value) => {
  const artifact = projectArtifactReference(value?.artifact);
  if (!hasExactKeys(value, ['artifact', 'status', 'updatedAt', 'failure']) || artifact === null
    || !['ready', 'running', 'stopped', 'failed', 'blocked'].includes(value.status) || !validTimestamp(value.updatedAt)) return null;
  const requiresFailure = ['failed', 'blocked'].includes(value.status);
  let failure = null;
  if (value.failure !== null) {
    if (!hasExactKeys(value.failure, ['code', 'message']) || !Object.hasOwn(BOARD_ERROR_STATUS, value.failure.code)
      || !safeText(value.failure.message) || containsSecretValue(value.failure.message)) return null;
    failure = { code: value.failure.code, message: value.failure.message };
  }
  if (requiresFailure !== (failure !== null)) return null;
  return { artifact, status: value.status, updatedAt: value.updatedAt, failure };
};

const projectArtifactManifest = (value) => {
  const artifact = projectArtifactReference(value?.artifact);
  if (!hasExactKeys(value, ['protocolVersion', 'type', 'artifact', 'entryPath', 'resources', 'requestedCapabilities'])
    || value.protocolVersion !== 1 || value.type !== 'artifact.manifest' || artifact === null
    || typeof value.entryPath !== 'string' || value.entryPath.length < 1 || value.entryPath.startsWith('/')
    || value.entryPath.includes('\\') || value.entryPath.includes('\0')
    || value.entryPath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > BOARD_LIMITS.maxArtifactResources
    || exactCatalog(value.requestedCapabilities, ARTIFACT_CAPABILITIES) === null) return null;
  const resources = [];
  const paths = new Set();
  let totalBytes = 0;
  for (const resource of value.resources) {
    if (!hasExactKeys(resource, ['path', 'mediaType', 'sha256', 'byteLength']) || typeof resource.path !== 'string'
      || resource.path.length < 1 || resource.path.startsWith('/') || resource.path.includes('\\') || resource.path.includes('\0')
      || resource.path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
      || paths.has(resource.path) || typeof resource.mediaType !== 'string'
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]{1,127}$/u.test(resource.mediaType)
      || typeof resource.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(resource.sha256)
      || !Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0
      || resource.byteLength > BOARD_LIMITS.maxArtifactResourceBytes) return null;
    paths.add(resource.path);
    totalBytes += resource.byteLength;
    resources.push({ path: resource.path, mediaType: resource.mediaType, sha256: resource.sha256, byteLength: resource.byteLength });
  }
  if (!paths.has(value.entryPath) || totalBytes > BOARD_LIMITS.maxArtifactTotalBytes) return null;
  return { protocolVersion: 1, type: 'artifact.manifest', artifact, entryPath: value.entryPath,
    resources, requestedCapabilities: [...value.requestedCapabilities] };
};

const hasOptionalExactKeys = (value, required, optional = []) => {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key));
};

const validContentText = (value, maximum) => typeof value === 'string' && [...value].length <= maximum
  && !/[\uD800-\uDFFF]/u.test(value) && !containsSecretValue(value);

const projectHitlOption = (value, parentContext) => {
  if (!hasOptionalExactKeys(value, ['id', 'label'], ['description']) || !validLocalId(value.id)
    || !safeText(value.label) || containsSecretValue(value.label)
    || (value.description !== undefined && (!safeText(value.description) || containsSecretValue(value.description)))
    || hasContextualSecret([parentContext, value.id], [value.id, value.label, value.description])) return null;
  return { id: value.id, label: value.label, ...(value.description === undefined ? {} : { description: value.description }) };
};

const projectHitlOptions = (value, parentContext) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOARD_LIMITS.maxHitlOptions) return null;
  const options = value.map((option) => projectHitlOption(option, parentContext));
  return options.some((option) => option === null) || new Set(options.map((option) => option.id)).size !== options.length
    ? null : options;
};

const projectHitlField = (value) => {
  if (!isRecord(value) || !validLocalId(value.id) || !safeText(value.label) || containsSecretValue(value.label)
    || hasContextualSecret([value.id], [value.label]) || typeof value.required !== 'boolean') return null;
  if (value.type === 'text') {
    if (!hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue', 'minLength', 'maxLength'])
      || !Number.isSafeInteger(value.minLength) || value.minLength < 0 || value.minLength > BOARD_LIMITS.maxHitlTextChars
      || !Number.isSafeInteger(value.maxLength) || value.maxLength < 1 || value.maxLength > BOARD_LIMITS.maxHitlTextChars
      || value.minLength > value.maxLength
      || (value.defaultValue !== null && (!validContentText(value.defaultValue, BOARD_LIMITS.maxHitlTextChars)
        || [...value.defaultValue].length < value.minLength || [...value.defaultValue].length > value.maxLength
        || hasContextualSecret([value.id], [value.defaultValue])))) return null;
    return { id: value.id, type: 'text', label: value.label, required: value.required,
      defaultValue: value.defaultValue, minLength: value.minLength, maxLength: value.maxLength };
  }
  if (value.type === 'number') {
    if (!hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue', 'min', 'max'])
      || (value.defaultValue !== null && (typeof value.defaultValue !== 'number' || !Number.isFinite(value.defaultValue)))
      || (value.min !== null && (typeof value.min !== 'number' || !Number.isFinite(value.min)))
      || (value.max !== null && (typeof value.max !== 'number' || !Number.isFinite(value.max)))
      || (value.min !== null && value.max !== null && value.min > value.max)
      || (value.defaultValue !== null && ((value.min !== null && value.defaultValue < value.min)
        || (value.max !== null && value.defaultValue > value.max)))) return null;
    return { id: value.id, type: 'number', label: value.label, required: value.required,
      defaultValue: value.defaultValue, min: value.min, max: value.max };
  }
  if (value.type === 'boolean') {
    if (!hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue'])
      || (value.defaultValue !== null && typeof value.defaultValue !== 'boolean')) return null;
    return { id: value.id, type: 'boolean', label: value.label, required: value.required, defaultValue: value.defaultValue };
  }
  if (value.type === 'select') {
    const options = projectHitlOptions(value.options, value.id);
    if (!hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue', 'options']) || options === null
      || (value.defaultValue !== null && (!validLocalId(value.defaultValue)
        || !options.some((option) => option.id === value.defaultValue)
        || hasContextualSecret([value.id], [value.defaultValue])))) return null;
    return { id: value.id, type: 'select', label: value.label, required: value.required,
      defaultValue: value.defaultValue, options };
  }
  return null;
};

const projectHitlDefinition = (value) => {
  if (!isRecord(value) || !HITL_KINDS.includes(value.kind) || !safeText(value.title) || containsSecretValue(value.title)) return null;
  let definition = null;
  if (value.kind === 'info') {
    if (hasExactKeys(value, ['kind', 'title', 'body', 'acknowledgeLabel'])
      && validContentText(value.body, BOARD_LIMITS.maxMarkdownChars)
      && safeText(value.acknowledgeLabel) && !containsSecretValue(value.acknowledgeLabel)) {
      definition = { kind: 'info', title: value.title, body: value.body, acknowledgeLabel: value.acknowledgeLabel };
    }
  } else if (value.kind === 'choice') {
    const options = projectHitlOptions(value.options);
    if (hasOptionalExactKeys(value, ['kind', 'title', 'multiple', 'minSelections', 'maxSelections', 'options'], ['body'])
      && (value.body === undefined || validContentText(value.body, BOARD_LIMITS.maxMarkdownChars))
      && typeof value.multiple === 'boolean' && Number.isSafeInteger(value.minSelections) && value.minSelections >= 1
      && Number.isSafeInteger(value.maxSelections) && value.maxSelections >= 1 && options !== null
      && value.minSelections <= value.maxSelections && value.maxSelections <= options.length
      && (value.multiple || (value.minSelections === 1 && value.maxSelections === 1))) {
      definition = { kind: 'choice', title: value.title, ...(value.body === undefined ? {} : { body: value.body }),
        multiple: value.multiple, minSelections: value.minSelections, maxSelections: value.maxSelections, options };
    }
  } else if (value.kind === 'form') {
    const fields = Array.isArray(value.fields) ? value.fields.map(projectHitlField) : [];
    if (hasOptionalExactKeys(value, ['kind', 'title', 'fields', 'submitLabel'], ['body'])
      && (value.body === undefined || validContentText(value.body, BOARD_LIMITS.maxMarkdownChars))
      && Array.isArray(value.fields) && fields.length >= 1 && fields.length <= BOARD_LIMITS.maxHitlFields
      && !fields.some((field) => field === null) && new Set(fields.map((field) => field.id)).size === fields.length
      && safeText(value.submitLabel) && !containsSecretValue(value.submitLabel)) {
      definition = { kind: 'form', title: value.title, ...(value.body === undefined ? {} : { body: value.body }),
        fields, submitLabel: value.submitLabel };
    }
  } else if (hasExactKeys(value, ['kind', 'title', 'body', 'impact', 'confirmLabel', 'cancelLabel'])
    && validContentText(value.body, BOARD_LIMITS.maxMarkdownChars) && ['standard', 'destructive'].includes(value.impact)
    && safeText(value.confirmLabel) && !containsSecretValue(value.confirmLabel)
    && safeText(value.cancelLabel) && !containsSecretValue(value.cancelLabel)) {
    definition = { kind: 'confirmation', title: value.title, body: value.body, impact: value.impact,
      confirmLabel: value.confirmLabel, cancelLabel: value.cancelLabel };
  }
  return definition !== null && publicJsonTree(definition) ? definition : null;
};

const projectHitlResponse = (value, definition) => {
  if (!isRecord(value) || value.kind !== definition.kind) return null;
  let response = null;
  if (value.kind === 'info') {
    if (hasExactKeys(value, ['kind', 'acknowledged']) && value.acknowledged === true) response = { kind: 'info', acknowledged: true };
  } else if (value.kind === 'choice') {
    const selected = value.selectedOptionIds;
    const known = new Set(definition.options.map((option) => option.id));
    if (hasExactKeys(value, ['kind', 'selectedOptionIds']) && Array.isArray(selected)
      && selected.length >= definition.minSelections && selected.length <= definition.maxSelections
      && selected.length <= BOARD_LIMITS.maxHitlOptions && selected.every(validLocalId)
      && new Set(selected).size === selected.length && selected.every((id) => known.has(id))) {
      response = { kind: 'choice', selectedOptionIds: [...selected] };
    }
  } else if (value.kind === 'form') {
    const values = value.values;
    const fields = new Map(definition.fields.map((field) => [field.id, field]));
    if (hasExactKeys(value, ['kind', 'values']) && isRecord(values)
      && Object.keys(values).length === fields.size && Object.keys(values).every((key) => validLocalId(key) && fields.has(key))) {
      let valid = true;
      const projected = {};
      for (const [id, field] of fields) {
        const item = values[id];
        if (item === null) valid = !field.required;
        else if (field.type === 'text') valid = validContentText(item, BOARD_LIMITS.maxHitlTextChars)
          && [...item].length >= field.minLength && [...item].length <= field.maxLength;
        else if (field.type === 'number') valid = typeof item === 'number' && Number.isFinite(item)
          && (field.min === null || item >= field.min) && (field.max === null || item <= field.max);
        else if (field.type === 'boolean') valid = typeof item === 'boolean';
        else valid = validLocalId(item) && field.options.some((option) => option.id === item);
        if (!valid) break;
        projected[id] = item;
      }
      if (valid) response = { kind: 'form', values: projected };
    }
  } else if (hasExactKeys(value, ['kind', 'confirmed']) && typeof value.confirmed === 'boolean') {
    response = { kind: 'confirmation', confirmed: value.confirmed };
  }
  return response !== null && publicJsonTree(response) ? response : null;
};

const projectHitl = (value) => {
  const definition = projectHitlDefinition(value?.definition);
  if (!hasExactKeys(value, ['hitlRequestId', 'definition', 'state', 'createdAt', 'expiresAt', 'stateUpdatedAt', 'response', 'answeredAt'])
    || !validGlobalId(value.hitlRequestId) || definition === null
    || !['open', 'answered', 'superseded', 'expired', 'cancelled'].includes(value.state)
    || !validTimestamp(value.createdAt) || (value.expiresAt !== null && !validTimestamp(value.expiresAt))
    || !validTimestamp(value.stateUpdatedAt) || (value.answeredAt !== null && !validTimestamp(value.answeredAt))) return null;
  const response = value.response === null ? null : projectHitlResponse(value.response, definition);
  if (value.response !== null && response === null) return null;
  const created = Date.parse(value.createdAt);
  const updated = Date.parse(value.stateUpdatedAt);
  const expires = value.expiresAt === null ? null : Date.parse(value.expiresAt);
  const answered = value.answeredAt === null ? null : Date.parse(value.answeredAt);
  if (expires !== null && expires <= created) return null;
  if (value.state === 'open') {
    if (response !== null || answered !== null || updated !== created) return null;
  } else if (value.state === 'answered') {
    if (response === null || answered === null || answered <= created || updated !== answered
      || (expires !== null && answered >= expires)) return null;
  } else if (value.state === 'expired') {
    if (response !== null || answered !== null || expires === null || updated < expires) return null;
  } else if (response !== null || answered !== null || updated <= created || (expires !== null && updated >= expires)) return null;
  return { hitlRequestId: value.hitlRequestId, definition, state: value.state,
    createdAt: value.createdAt, expiresAt: value.expiresAt, stateUpdatedAt: value.stateUpdatedAt,
    response, answeredAt: value.answeredAt };
};

const projectBoardSnapshot = (value) => {
  const revision = projectSnapshotRevision(value?.revision);
  const capabilities = parseCapabilities(value?.capabilities);
  if (!hasExactKeys(value, ['protocolVersion', 'type', 'boardId', 'revision', 'scene', 'hitl', 'artifacts', 'capabilities', 'lastEventSequence'])
    || value.protocolVersion !== 1 || value.type !== 'board.snapshot' || !validGlobalId(value.boardId)
    || revision === null || !hasExactKeys(value.scene, ['protocolVersion', 'type', 'root'])
    || value.scene.protocolVersion !== 1 || value.scene.type !== 'scene' || !publicJsonTree(value.scene.root)
    || !Array.isArray(value.hitl) || !Array.isArray(value.artifacts) || capabilities === null
    || !Number.isSafeInteger(value.lastEventSequence) || value.lastEventSequence < 0) return null;
  const hitl = value.hitl.map(projectHitl);
  const artifacts = value.artifacts.map(projectArtifactRuntime);
  if (hitl.some((item) => item === null) || artifacts.some((item) => item === null)
    || new Set(hitl.map((item) => item.hitlRequestId)).size !== hitl.length
    || new Set(artifacts.map((item) => `${item.artifact.artifactId}\0${item.artifact.versionId}`)).size !== artifacts.length) return null;
  return { protocolVersion: 1, type: 'board.snapshot', boardId: value.boardId, revision,
    scene: { protocolVersion: 1, type: 'scene', root: structuredClone(value.scene.root) }, hitl, artifacts,
    capabilities, lastEventSequence: value.lastEventSequence };
};

const projectHistoryEntry = (value) => {
  const revision = projectRevisionSummary(value?.revision);
  const actor = projectActor(value?.actor);
  if (!hasExactKeys(value, ['revision', 'previousRevisionId', 'originType', 'sourceRevisionId', 'actor'])
    || revision === null || actor === null || (value.previousRevisionId !== null && !validGlobalId(value.previousRevisionId))
    || !['board.create', 'scene.replace', 'scene.clear', 'scene.restore'].includes(value.originType)
    || (value.sourceRevisionId !== null && !validGlobalId(value.sourceRevisionId))) return null;
  return { revision, previousRevisionId: value.previousRevisionId, originType: value.originType,
    sourceRevisionId: value.sourceRevisionId, actor };
};

const projectHistoryMetadata = (value) => {
  if (!hasExactKeys(value, ['protocolVersion', 'type', 'entries', 'navigation']) || value.protocolVersion !== 1
    || value.type !== 'history.adapter-metadata' || !Array.isArray(value.entries) || value.entries.length > 100) return null;
  const entries = [];
  for (const entry of value.entries) {
    if (!hasExactKeys(entry, ['revisionId', 'label']) || !validGlobalId(entry.revisionId)
      || !safeText(entry.label) || containsSecretValue(entry.label)) return null;
    entries.push({ revisionId: entry.revisionId, label: entry.label });
  }
  let navigation = null;
  if (value.navigation !== null) {
    if (!hasExactKeys(value.navigation, ['revisionId', 'previousRevisionId', 'nextRevisionId', 'latestRevisionId'])
      || !validGlobalId(value.navigation.revisionId) || !validGlobalId(value.navigation.latestRevisionId)
      || (value.navigation.previousRevisionId !== null && !validGlobalId(value.navigation.previousRevisionId))
      || (value.navigation.nextRevisionId !== null && !validGlobalId(value.navigation.nextRevisionId))) return null;
    navigation = { ...value.navigation };
  }
  return { protocolVersion: 1, type: 'history.adapter-metadata', entries, navigation };
};

const projectResultData = (type, data, correlation) => {
  if (!isRecord(data) || data.type !== type || !publicJsonTree(data)) return null;
  if (type === 'board.list') {
    if (!hasExactKeys(data, ['type', 'boards', 'nextCursor']) || !Array.isArray(data.boards) || data.boards.length > 100
      || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !CURSOR_PATTERN.test(data.nextCursor)))) return null;
    const boards = data.boards.map(projectBoardSummary);
    return boards.some((item) => item === null) ? null : { type, boards, nextCursor: data.nextCursor };
  }
  if (type === 'board.get' || type === 'board.create') {
    const board = projectBoardSummary(data.board);
    const snapshot = projectBoardSnapshot(data.snapshot);
    if (!hasExactKeys(data, ['type', 'board', 'snapshot']) || board === null || snapshot === null
      || board.boardId !== snapshot.boardId || board.headRevision.revisionId !== snapshot.revision.revisionId
      || (correlation?.boardId !== undefined && board.boardId !== correlation.boardId)) return null;
    if (type === 'board.create' && (snapshot.revision.revisionNumber !== 1 || snapshot.scene.root !== null)) return null;
    return { type, board, snapshot };
  }
  if (type === 'board.archive') {
    const board = projectBoardSummary(data.board);
    return hasExactKeys(data, ['type', 'board']) && board !== null
      && (correlation?.boardId === undefined || board.boardId === correlation.boardId) ? { type, board } : null;
  }
  if (type === 'capabilities.get') {
    const capabilities = parseCapabilities(data.capabilities);
    return hasExactKeys(data, ['type', 'capabilities']) && capabilities !== null ? { type, capabilities } : null;
  }
  if (type === 'history.list') {
    if (!hasExactKeys(data, ['type', 'entries', 'nextCursor']) || !Array.isArray(data.entries) || data.entries.length > 100
      || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !CURSOR_PATTERN.test(data.nextCursor)))) return null;
    const entries = data.entries.map(projectHistoryEntry);
    return entries.some((item) => item === null) ? null : { type, entries, nextCursor: data.nextCursor };
  }
  if (type === 'history.get') {
    const entry = projectHistoryEntry(data.entry);
    const snapshot = projectBoardSnapshot(data.snapshot);
    return hasExactKeys(data, ['type', 'entry', 'snapshot']) && entry !== null && snapshot !== null
      && entry.revision.revisionId === snapshot.revision.revisionId
      && (correlation?.boardId === undefined || snapshot.boardId === correlation.boardId)
      && (correlation?.revisionId === undefined || entry.revision.revisionId === correlation.revisionId)
      ? { type, entry, snapshot } : null;
  }
  if (type === 'artifact.get') {
    const manifest = projectArtifactManifest(data.manifest);
    const runtime = projectArtifactRuntime(data.runtime);
    return hasExactKeys(data, ['type', 'manifest', 'runtime']) && manifest !== null && runtime !== null
      && manifest.artifact.artifactId === runtime.artifact.artifactId
      && manifest.artifact.versionId === runtime.artifact.versionId
      && (correlation?.artifactId === undefined || (manifest.artifact.artifactId === correlation.artifactId
        && manifest.artifact.versionId === correlation.versionId)) ? { type, manifest, runtime } : null;
  }
  if (type === 'hitl.read') {
    const hitl = projectHitl(data.hitl);
    return hasExactKeys(data, ['type', 'changed', 'hitl']) && typeof data.changed === 'boolean' && hitl !== null
      && (correlation?.hitlRequestId === undefined || hitl.hitlRequestId === correlation.hitlRequestId)
      ? { type, changed: data.changed, hitl } : null;
  }
  if (type === 'scene.replace' || type === 'scene.clear') {
    const revision = projectRevisionSummary(data.revision);
    return hasExactKeys(data, ['type', 'revision']) && revision !== null ? { type, revision } : null;
  }
  if (type === 'scene.restore') {
    const revision = projectRevisionSummary(data.revision);
    return hasExactKeys(data, ['type', 'sourceRevisionId', 'revision']) && validGlobalId(data.sourceRevisionId)
      && revision !== null && (correlation?.revisionId === undefined || data.sourceRevisionId === correlation.revisionId)
      ? { type, sourceRevisionId: data.sourceRevisionId, revision } : null;
  }
  if (type === 'hitl.request' || type === 'hitl.respond') {
    const hitl = projectHitl(data.hitl);
    return hasExactKeys(data, ['type', 'hitl']) && hitl !== null
      && hitl.state === (type === 'hitl.request' ? 'open' : 'answered')
      && (correlation?.hitlRequestId === undefined || hitl.hitlRequestId === correlation.hitlRequestId)
      ? { type, hitl } : null;
  }
  if (type === 'artifact.publish' || type === 'artifact.stop') {
    const artifact = projectArtifactRuntime(data.artifact);
    return hasExactKeys(data, ['type', 'artifact']) && artifact !== null
      && (correlation?.artifactId === undefined || (artifact.artifact.artifactId === correlation.artifactId
        && (correlation.versionId === undefined || artifact.artifact.versionId === correlation.versionId)))
      ? { type, artifact } : null;
  }
  return null;
};

const projectBoardEnvelope = (parsed, { requestId, expectedType, status, correlation }) => {
  if (!hasExactKeys(parsed, ['protocolVersion', 'type', 'requestId', 'result', 'metadata'])
    || parsed.protocolVersion !== 1 || parsed.type !== 'board.http.success' || parsed.requestId !== requestId
    || !hasExactKeys(parsed.metadata, ['history']) || !isRecord(parsed.result)
    || parsed.result.protocolVersion !== 1 || parsed.result.requestId !== requestId
    || typeof parsed.result.replayed !== 'boolean') return null;
  const source = parsed.result;
  let result;
  if (source.type === 'mutation.result') {
    if (!hasExactKeys(source, ['protocolVersion', 'type', 'requestId', 'boardId', 'replayed', 'eventIds', 'result'])
      || correlation?.boardId === undefined || source.boardId !== correlation.boardId
      || !Array.isArray(source.eventIds) || source.eventIds.some((id) => !validGlobalId(id))
      || new Set(source.eventIds).size !== source.eventIds.length) return null;
    const data = projectResultData(expectedType, source.result, correlation);
    if (data === null) return null;
    result = { protocolVersion: 1, type: 'mutation.result', requestId, boardId: source.boardId,
      replayed: source.replayed, eventIds: [...source.eventIds], result: data };
  } else if (source.type === 'board.operation.result') {
    if (!hasExactKeys(source, ['protocolVersion', 'type', 'requestId', 'replayed', 'result'])) return null;
    const data = projectResultData(expectedType, source.result, correlation);
    if (data === null || (!['board.create', 'board.archive'].includes(expectedType) && source.replayed)) return null;
    result = { protocolVersion: 1, type: 'board.operation.result', requestId, replayed: source.replayed, result: data };
  } else return null;
  if (expectedType === 'board.create' ? status !== (result.replayed ? 200 : 201) : status !== 200) return null;
  const historyValue = parsed.metadata.history;
  const history = historyValue === null ? null : projectHistoryMetadata(historyValue);
  if (historyValue !== null && history === null) return null;
  if (expectedType === 'history.list') {
    if (history === null || history.navigation !== null || history.entries.length !== result.result.entries.length
      || result.result.entries.some((entry, index) => entry.revision.revisionId !== history.entries[index]?.revisionId)) return null;
  } else if (expectedType === 'history.get') {
    const revisionId = result.result.entry.revision.revisionId;
    if (history === null || history.entries.length !== 1 || history.entries[0]?.revisionId !== revisionId
      || history.navigation?.revisionId !== revisionId) return null;
  } else if (history !== null) return null;
  return { protocolVersion: 1, type: 'board.http.success', requestId, result, metadata: { history } };
};

export const requestJson = async ({
  config,
  path,
  method = 'GET',
  body = null,
  authorization = null,
  requestId = null,
  expectedStatus,
  expectedType = null,
  allowedErrorCodes = null,
  retryKind = 'none',
  requirePairingHeaders = null,
  correlation = null,
  connectionBoardId = undefined,
  timeoutMs = config.timeoutMs,
  operationDeadline = null,
  fetchImpl = fetch,
}) => {
  const maximumAttempts = retryKind === 'read' ? 3 : retryKind === 'mutation' ? 2 : 1;
  const timeoutFailure = (phase) => new SceneBoardApiError('BOARD_API_TIMEOUT', 'SceneBoard request timed out', {
    retryable: true,
    details: { phase },
  });
  const deadline = operationDeadline === null ? performance.now() + timeoutMs : operationDeadline;
  const remainingAtStart = deadline - performance.now();
  if (!Number.isFinite(deadline) || remainingAtStart <= 0) throw timeoutFailure('request');
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingAtStart)));
  const sleepBeforeRetry = async (delay) => {
    if (!Number.isFinite(delay) || delay < 0 || delay >= Math.max(0, deadline - performance.now())) throw timeoutFailure('retry');
    if (!await sleep(delay, timeoutSignal)) throw timeoutFailure('retry');
  };
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (timeoutSignal.aborted) break;
    let response;
    try {
      response = await fetchImpl(new URL(path, config.baseUrl), {
        method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          ...(authorization === null ? {} : { Authorization: authorization }),
          ...(requestId === null ? {} : { 'X-Request-Id': requestId }),
          ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: timeoutSignal,
      });
    } catch (error) {
      if (attempt < maximumAttempts && !timeoutSignal.aborted) {
        await sleepBeforeRetry(100 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100));
        continue;
      }
      throw new SceneBoardApiError(
        timeoutSignal.aborted ? 'BOARD_API_TIMEOUT' : 'BOARD_API_TRANSPORT_ERROR',
        timeoutSignal.aborted ? 'SceneBoard request timed out' : 'SceneBoard transport is unavailable',
        { retryable: true, details: { phase: 'request' } },
      );
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
        details: { reason: 'redirect' },
      });
    }
    if (response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8') {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
        details: { reason: 'content_type' },
      });
    }
    if (requestId !== null && response.headers.get('x-request-id') !== requestId) {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
        details: { reason: 'correlation' },
      });
    }
    if (requirePairingHeaders !== null) {
      const vary = requirePairingHeaders === 'claim' ? null
        : requirePairingHeaders === 'connection' ? 'Origin, Cookie, Authorization' : 'Authorization';
      if (response.headers.get('cache-control') !== 'no-store, private'
        || response.headers.get('pragma') !== 'no-cache' || response.headers.get('vary') !== vary) {
        await response.body?.cancel().catch(() => undefined);
        throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard pairing response is invalid', {
          details: { reason: 'headers' },
        });
      }
    }
    let bytes;
    try {
      bytes = await readBoundedBody(
        response,
        response.status >= 200 && response.status < 300 ? SUCCESS_BODY_LIMIT : ERROR_BODY_LIMIT,
        timeoutSignal,
      );
    } catch (error) {
      if (error instanceof SceneBoardApiError) throw error;
      throw new SceneBoardApiError(
        timeoutSignal.aborted ? 'BOARD_API_TIMEOUT' : 'BOARD_API_TRANSPORT_ERROR',
        timeoutSignal.aborted ? 'SceneBoard response timed out' : 'SceneBoard response is unavailable',
        { retryable: true, details: { phase: 'response' } },
      );
    }
    const parsed = parseJsonBytes(bytes, 'SceneBoard response');
    if (!expectedStatus.includes(response.status)) {
      const responseError = errorFromResponse(
        parsed,
        response,
        ['claim', 'status', 'redeem'].includes(requirePairingHeaders),
        allowedErrorCodes,
      );
      const canRetry = attempt < maximumAttempts
        && responseError.retryable
        && ['RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(responseError.code);
      if (canRetry) {
        const retryAfterHeader = parseRetryAfter(response);
        if (retryAfterHeader === 'invalid') {
          throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
            details: { reason: 'headers' },
          });
        }
        const retryAfter = retryAfterHeader ?? Number(responseError.details?.retryAfterSeconds);
        const delay = Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120
          ? retryAfter * 1_000
          : 100 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
        await sleepBeforeRetry(delay);
        continue;
      }
      throw responseError;
    }
    if (connectionBoardId !== undefined) {
      const connection = parseConnection(parsed, connectionBoardId);
      if (connection === null) {
        throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard connection response is invalid', {
          details: { reason: 'schema' },
        });
      }
      return connection;
    }
    if (expectedType !== null) {
      const projected = projectBoardEnvelope(parsed, { requestId, expectedType, status: response.status, correlation });
      if (projected === null) {
        throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
          details: { reason: 'schema' },
        });
      }
      return projected;
    }
    if (!['claim', 'status', 'redeem'].includes(requirePairingHeaders) && !publicJsonTree(parsed)) {
      throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', {
        details: { reason: 'secret_material' },
      });
    }
    return parsed;
  }
  throw timeoutSignal.aborted ? timeoutFailure('request')
    : new SceneBoardApiError('BOARD_API_TRANSPORT_ERROR', 'SceneBoard transport is unavailable', { retryable: true });
};

const invalidInput = (field) => {
  throw new SceneBoardApiError('INVALID_PAYLOAD', 'Invalid SceneBoard API fallback input', { details: { field }, exitCode: 2 });
};

const assertExactInput = (input, keys) => {
  if (!hasExactKeys(input, keys)) invalidInput('input');
};

const globalId = (value, field) => {
  if (typeof value !== 'string' || !GLOBAL_ID_PATTERN.test(value)) invalidInput(field);
  return value;
};

const idempotencyKey = (value) => {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) invalidInput('idempotencyKey');
  return value;
};

const page = (cursor, limit) => {
  if (cursor !== null && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor))) invalidInput('cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidInput('limit');
};

const baseMutation = (input, requestId, command) => ({
  protocolVersion: 1,
  requestId,
  boardId: globalId(input.boardId, 'boardId'),
  expectedRevisionId: globalId(input.expectedRevisionId, 'expectedRevisionId'),
  idempotencyKey: idempotencyKey(input.idempotencyKey),
  command,
});

const protectedSpec = (operation, input, requestId) => {
  if (!isRecord(input)) invalidInput('input');
  if (operation === 'board_list') {
    assertExactInput(input, ['cursor', 'limit', 'includeArchived']);
    page(input.cursor, input.limit);
    if (typeof input.includeArchived !== 'boolean') invalidInput('includeArchived');
    const query = new URLSearchParams({ requestId, limit: String(input.limit), includeArchived: String(input.includeArchived) });
    if (input.cursor !== null) query.set('cursor', input.cursor);
    return { path: `/api/v1/boards?${query}`, method: 'GET', body: null, expectedType: 'board.list', retryKind: 'read' };
  }
  if (operation === 'board_get' || operation === 'board_capabilities_get') {
    assertExactInput(input, ['boardId']);
    const boardId = globalId(input.boardId, 'boardId');
    const suffix = operation === 'board_get' ? '' : '/capabilities';
    return { path: `/api/v1/boards/${boardId}${suffix}?requestId=${requestId}`, method: 'GET', body: null, expectedType: operation === 'board_get' ? 'board.get' : 'capabilities.get', retryKind: 'read', correlation: { boardId } };
  }
  if (operation === 'board_create') {
    assertExactInput(input, ['title', 'idempotencyKey']);
    if (typeof input.title !== 'string' || [...input.title].length < 1 || [...input.title].length > 200) invalidInput('title');
    return { path: '/api/v1/boards', method: 'POST', body: { protocolVersion: 1, requestId, type: 'board.create', title: input.title, idempotencyKey: idempotencyKey(input.idempotencyKey) }, expectedType: 'board.create', retryKind: 'mutation' };
  }
  if (operation === 'board_archive') {
    assertExactInput(input, ['boardId', 'confirm', 'idempotencyKey']);
    if (input.confirm !== true) invalidInput('confirm');
    const boardId = globalId(input.boardId, 'boardId');
    return { path: `/api/v1/boards/${boardId}/archive`, method: 'POST', body: { protocolVersion: 1, requestId, type: 'board.archive', boardId, confirm: true, idempotencyKey: idempotencyKey(input.idempotencyKey) }, expectedType: 'board.archive', retryKind: 'mutation', correlation: { boardId } };
  }
  if (operation === 'board_scene_get') {
    assertExactInput(input, ['boardId', 'revisionId']);
    const boardId = globalId(input.boardId, 'boardId');
    if (input.revisionId === null) return { path: `/api/v1/boards/${boardId}?requestId=${requestId}`, method: 'GET', body: null, expectedType: 'board.get', retryKind: 'read', correlation: { boardId } };
    const revisionId = globalId(input.revisionId, 'revisionId');
    return { path: `/api/v1/boards/${boardId}/revisions/${revisionId}?requestId=${requestId}`, method: 'GET', body: null, expectedType: 'history.get', retryKind: 'read', correlation: { boardId, revisionId } };
  }
  if (operation === 'board_scene_replace') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'scene']);
    if (!isRecord(input.scene)) invalidInput('scene');
    return mutationSpec(baseMutation(input, requestId, { type: 'scene.replace', scene: input.scene }), 'scene.replace');
  }
  if (operation === 'board_scene_clear') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey']);
    return mutationSpec(baseMutation(input, requestId, { type: 'scene.clear' }), 'scene.clear');
  }
  if (operation === 'board_artifact_get') {
    assertExactInput(input, ['boardId', 'artifactId', 'versionId']);
    const boardId = globalId(input.boardId, 'boardId');
    const artifactId = globalId(input.artifactId, 'artifactId');
    const versionId = globalId(input.versionId, 'versionId');
    return { path: `/api/v1/boards/${boardId}/artifacts/${artifactId}/versions/${versionId}?requestId=${requestId}`, method: 'GET', body: null, expectedType: 'artifact.get', retryKind: 'read', correlation: { boardId, artifactId, versionId } };
  }
  if (operation === 'board_artifact_put') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'artifactId', 'html', 'css', 'javascript', 'requestedCapabilities']);
    globalId(input.boardId, 'boardId');
    globalId(input.expectedRevisionId, 'expectedRevisionId');
    idempotencyKey(input.idempotencyKey);
    if (input.artifactId !== null) globalId(input.artifactId, 'artifactId');
    if (typeof input.html !== 'string' || (input.css !== null && typeof input.css !== 'string')
      || (input.javascript !== null && typeof input.javascript !== 'string')) invalidInput('source');
    assertSortedCatalog(input.requestedCapabilities, ARTIFACT_CAPABILITIES, 'requestedCapabilities', true);
    return { path: `/api/v1/boards/${input.boardId}/artifacts`, method: 'POST', body: input, expectedType: 'artifact.publish', retryKind: 'mutation',
      correlation: { boardId: input.boardId, ...(input.artifactId === null ? {} : { artifactId: input.artifactId }) } };
  }
  if (operation === 'board_artifact_stop') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'artifactId', 'versionId', 'reason']);
    if (typeof input.reason !== 'string' || [...input.reason].length < 1 || [...input.reason].length > 200) invalidInput('reason');
    return { ...mutationSpec(baseMutation(input, requestId, { type: 'artifact.stop', artifact: { artifactId: globalId(input.artifactId, 'artifactId'), versionId: globalId(input.versionId, 'versionId') }, reason: input.reason }), 'artifact.stop'),
      correlation: { boardId: input.boardId, artifactId: input.artifactId, versionId: input.versionId } };
  }
  if (operation === 'board_history_list') {
    assertExactInput(input, ['boardId', 'cursor', 'limit']);
    const boardId = globalId(input.boardId, 'boardId');
    page(input.cursor, input.limit);
    const query = new URLSearchParams({ requestId, limit: String(input.limit) });
    if (input.cursor !== null) query.set('cursor', input.cursor);
    return { path: `/api/v1/boards/${boardId}/revisions?${query}`, method: 'GET', body: null, expectedType: 'history.list', retryKind: 'read', correlation: { boardId } };
  }
  if (operation === 'board_history_get') {
    assertExactInput(input, ['boardId', 'revisionId']);
    const boardId = globalId(input.boardId, 'boardId');
    const revisionId = globalId(input.revisionId, 'revisionId');
    return { path: `/api/v1/boards/${boardId}/revisions/${revisionId}?requestId=${requestId}`, method: 'GET', body: null, expectedType: 'history.get', retryKind: 'read', correlation: { boardId, revisionId } };
  }
  if (operation === 'board_history_restore') {
    assertExactInput(input, ['boardId', 'revisionId', 'expectedRevisionId', 'confirm', 'idempotencyKey']);
    if (input.confirm !== true) invalidInput('confirm');
    const boardId = globalId(input.boardId, 'boardId');
    const revisionId = globalId(input.revisionId, 'revisionId');
    return { path: `/api/v1/boards/${boardId}/revisions/${revisionId}/restore`, method: 'POST', body: { protocolVersion: 1, requestId, idempotencyKey: idempotencyKey(input.idempotencyKey), expectedRevisionId: globalId(input.expectedRevisionId, 'expectedRevisionId'), confirm: true }, expectedType: 'scene.restore', retryKind: 'mutation', correlation: { boardId, revisionId } };
  }
  if (operation === 'board_interaction_request') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'hitlRequestId', 'definition']);
    if (!isRecord(input.definition)) invalidInput('definition');
    return { ...mutationSpec(baseMutation(input, requestId, { type: 'hitl.request', hitlRequestId: globalId(input.hitlRequestId, 'hitlRequestId'), request: input.definition }), 'hitl.request'),
      correlation: { boardId: input.boardId, hitlRequestId: input.hitlRequestId } };
  }
  if (operation === 'board_interaction_status') {
    assertExactInput(input, ['boardId', 'hitlRequestId', 'wait']);
    const boardId = globalId(input.boardId, 'boardId');
    const hitlRequestId = globalId(input.hitlRequestId, 'hitlRequestId');
    const query = new URLSearchParams({ requestId });
    if (input.wait !== null) {
      if (!hasExactKeys(input.wait, ['afterStateUpdatedAt', 'timeoutMs'])
        || typeof input.wait.afterStateUpdatedAt !== 'string' || !Number.isSafeInteger(input.wait.timeoutMs)
        || input.wait.timeoutMs < 0 || input.wait.timeoutMs > 30_000) invalidInput('wait');
      query.set('afterStateUpdatedAt', input.wait.afterStateUpdatedAt);
      query.set('timeoutMs', String(input.wait.timeoutMs));
    }
    return {
      path: `/api/v1/boards/${boardId}/interactions/${hitlRequestId}?${query}`,
      method: 'GET',
      body: null,
      expectedType: 'hitl.read',
      retryKind: 'read',
      correlation: { boardId, hitlRequestId },
      minimumTimeoutMs: input.wait === null ? undefined : Math.max(30_000, input.wait.timeoutMs + 5_000),
    };
  }
  if (operation === 'board_interaction_respond') {
    assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'hitlRequestId', 'response']);
    if (!isRecord(input.response)) invalidInput('response');
    return { ...mutationSpec(baseMutation(input, requestId, { type: 'hitl.respond', hitlRequestId: globalId(input.hitlRequestId, 'hitlRequestId'), response: input.response }), 'hitl.respond'),
      correlation: { boardId: input.boardId, hitlRequestId: input.hitlRequestId } };
  }
  invalidInput('operation');
};

const mutationSpec = (body, expectedType) => ({
  path: `/api/v1/boards/${body.boardId}/mutations`,
  method: 'POST',
  body,
  expectedType,
  retryKind: 'mutation',
  correlation: { boardId: body.boardId },
});

export const assertSortedCatalog = (value, catalog, field, allowEmpty = false) => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > catalog.length) invalidInput(field);
  let previous = -1;
  for (const item of value) {
    const index = catalog.indexOf(item);
    if (index <= previous) invalidInput(field);
    previous = index;
  }
  return value;
};

export const validatePairInput = (input) => {
  assertExactInput(input, ['code', 'clientName', 'requestedScopes', 'requestedLifecyclePermissions']);
  if (typeof input.code !== 'string' || !PAIRING_CODE_PATTERN.test(input.code)) invalidInput('code');
  if (!validClientName(input.clientName)) invalidInput('clientName');
  assertSortedCatalog(input.requestedScopes, GRANT_SCOPES, 'requestedScopes');
  assertSortedCatalog(input.requestedLifecyclePermissions, LIFECYCLE_PERMISSIONS, 'requestedLifecyclePermissions', true);
  return { ...input, code: input.code.toUpperCase() };
};

const invalidPairingResponse = () => {
  throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard pairing response is invalid');
};

export const parsePairingClaim = (value) => {
  if (!hasExactKeys(value, ['pairingId', 'state', 'decisionExpiresAt', 'pollAfterSeconds'])
    || typeof value.pairingId !== 'string' || !GLOBAL_ID_PATTERN.test(value.pairingId)
    || value.state !== 'pending' || !validTimestamp(value.decisionExpiresAt) || value.pollAfterSeconds !== 2) {
    invalidPairingResponse();
  }
  return value;
};

export const parsePairingStatus = (value, pairingId) => {
  if (!hasExactKeys(value, ['pairingId', 'state', 'retryAfterSeconds', 'decisionExpiresAt', 'redeemExpiresAt'])
    || value.pairingId !== pairingId || !PAIRING_STATES.includes(value.state)
    || !validTimestamp(value.decisionExpiresAt)
    || (value.redeemExpiresAt !== null && !validTimestamp(value.redeemExpiresAt))) invalidPairingResponse();
  if (value.state === 'pending') {
    if (![2, 5, 10].includes(value.retryAfterSeconds) || value.redeemExpiresAt !== null) invalidPairingResponse();
  } else if (value.retryAfterSeconds !== null) invalidPairingResponse();
  if (['approved', 'redeemed'].includes(value.state) && value.redeemExpiresAt === null) invalidPairingResponse();
  if (value.state === 'denied' && value.redeemExpiresAt !== null) invalidPairingResponse();
  return value;
};

const parseRedeemedGrant = (grant) => {
  const scopes = exactCatalog(grant?.scopes, GRANT_SCOPES, 1);
  const lifecyclePermissions = exactCatalog(grant?.lifecyclePermissions, LIFECYCLE_PERMISSIONS);
  if (!hasExactKeys(grant, ['grantId', 'client', 'scopes', 'lifecyclePermissions', 'boardIds', 'lifetime', 'status', 'createdAt', 'activatedAt', 'lastUsedAt', 'expiresAt', 'revokedAt'])
    || !hasExactKeys(grant.client, ['clientId', 'clientName', 'installationFingerprint'])
    || typeof grant.grantId !== 'string' || !GLOBAL_ID_PATTERN.test(grant.grantId)
    || typeof grant.client.clientId !== 'string' || !GLOBAL_ID_PATTERN.test(grant.client.clientId)
    || !validClientName(grant.client.clientName)
    || typeof grant.client.installationFingerprint !== 'string' || !/^[A-Za-z0-9_-]{16}$/u.test(grant.client.installationFingerprint)
    || scopes === null || lifecyclePermissions === null
    || !Array.isArray(grant.boardIds) || grant.boardIds.length > 50
    || (grant.boardIds.length === 0 && (!scopes.includes('board.write') || !lifecyclePermissions.includes('board.create')))
    || grant.boardIds.some((id) => typeof id !== 'string' || !GLOBAL_ID_PATTERN.test(id))
    || new Set(grant.boardIds).size !== grant.boardIds.length
    || !['session', 'persistent'].includes(grant.lifetime) || grant.status !== 'active'
    || !validTimestamp(grant.createdAt) || !validTimestamp(grant.activatedAt)
    || (grant.lastUsedAt !== null && !validTimestamp(grant.lastUsedAt))
    || !validTimestamp(grant.expiresAt) || grant.revokedAt !== null) invalidPairingResponse();
  return grant;
};

export const parsePairingRedeem = (value) => {
  if (!hasExactKeys(value, ['tokenType', 'accessToken', 'grant']) || value.tokenType !== 'Bearer'
    || typeof value.accessToken !== 'string' || !TOKEN_PATTERN.test(value.accessToken)) invalidPairingResponse();
  parseRedeemedGrant(value.grant);
  return value;
};

const sameOrderedValues = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);

export const validatePairingAuthorization = (redeemed, connection, requested) => {
  const grant = redeemed?.grant;
  const authorized = connection?.grant;
  const principal = connection?.principal;
  if (!isRecord(grant) || !isRecord(authorized) || !isRecord(principal)
    || !isRecord(grant.client) || !isRecord(authorized.client)
    || principal.principalKind !== 'mcp_client' || principal.principalId !== grant.client.clientId
    || principal.grantId !== grant.grantId || authorized.grantId !== grant.grantId
    || authorized.client.clientId !== grant.client.clientId
    || authorized.client.clientName !== grant.client.clientName
    || authorized.client.installationFingerprint !== grant.client.installationFingerprint
    || requested.clientName !== grant.client.clientName
    || !sameOrderedValues(authorized.scopes, grant.scopes)
    || !sameOrderedValues(authorized.lifecyclePermissions, grant.lifecyclePermissions)
    || !sameOrderedValues(authorized.boardIds, grant.boardIds)
    || !grant.scopes.every((scope) => requested.requestedScopes.includes(scope))
    || !grant.lifecyclePermissions.every((permission) => requested.requestedLifecyclePermissions.includes(permission))
    || authorized.lifetime !== grant.lifetime || authorized.status !== grant.status
    || authorized.activatedAt !== grant.activatedAt || authorized.expiresAt !== grant.expiresAt) invalidPairingResponse();
  return true;
};

export const createPairingProof = () => {
  const bytes = randomBytes(32);
  return {
    bytes,
    value: bytes.toString('base64url'),
    challenge: createHash('sha256').update(bytes).digest('base64url'),
  };
};

const childrenOf = (node) => {
  if (!isRecord(node)) return null;
  if (['layout.split', 'layout.grid', 'layout.canvas'].includes(node.type) && Array.isArray(node.children)) return node.children;
  if (node.type === 'layout.tabs' && Array.isArray(node.tabs)) return node.tabs;
  return null;
};

const buildNodeIndex = (root) => {
  const index = new Map();
  if (root === null) return index;
  const stack = [{ node: root, parent: null, entryIndex: null }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current.node) || typeof current.node.id !== 'string' || index.has(current.node.id)) invalidInput('scene');
    index.set(current.node.id, current);
    const children = childrenOf(current.node);
    if (children !== null) {
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        if (!isRecord(children[childIndex]) || !isRecord(children[childIndex].node)) invalidInput('scene');
        stack.push({ node: children[childIndex].node, parent: current.node, entryIndex: childIndex });
      }
    }
  }
  return index;
};

const placementEntry = (parent, node, placement) => {
  if (!isRecord(placement) || placement.parentType !== parent.type) invalidInput('placement');
  const entry = structuredClone(placement);
  delete entry.parentType;
  return { node, ...entry };
};

const directChild = (parent, childNodeId) => (childrenOf(parent) ?? []).findIndex((entry) => entry.node?.id === childNodeId);

const applyPatchOperation = (scene, operation) => {
  if (!isRecord(operation) || typeof operation.type !== 'string') invalidInput('operations');
  const index = buildNodeIndex(scene.root);
  if (operation.type === 'replace_root') {
    assertExactInput(operation, ['type', 'root']);
    scene.root = structuredClone(operation.root);
    return;
  }
  if (operation.type === 'replace_node') {
    assertExactInput(operation, ['type', 'nodeId', 'node']);
    const location = index.get(globalId(operation.nodeId, 'nodeId'));
    if (location === undefined || !isRecord(operation.node) || operation.node.id !== operation.nodeId) invalidInput('node');
    if (location.parent === null) scene.root = structuredClone(operation.node);
    else childrenOf(location.parent)[location.entryIndex].node = structuredClone(operation.node);
    return;
  }
  if (operation.type === 'remove_node') {
    assertExactInput(operation, ['type', 'nodeId']);
    const location = index.get(globalId(operation.nodeId, 'nodeId'));
    if (location === undefined || location.parent === null) invalidInput('nodeId');
    childrenOf(location.parent).splice(location.entryIndex, 1);
    return;
  }
  if (operation.type === 'insert_child') {
    assertExactInput(operation, ['type', 'parentNodeId', 'index', 'node', 'placement']);
    const parent = index.get(globalId(operation.parentNodeId, 'parentNodeId'))?.node;
    const children = childrenOf(parent);
    if (children === null || !Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index > children.length
      || !isRecord(operation.node) || index.has(operation.node.id)) invalidInput('index');
    children.splice(operation.index, 0, placementEntry(parent, structuredClone(operation.node), operation.placement));
    return;
  }
  if (operation.type === 'move_child') {
    assertExactInput(operation, ['type', 'sourceParentNodeId', 'destinationParentNodeId', 'nodeId', 'destinationIndex', 'placement']);
    const source = index.get(globalId(operation.sourceParentNodeId, 'sourceParentNodeId'))?.node;
    const destination = index.get(globalId(operation.destinationParentNodeId, 'destinationParentNodeId'))?.node;
    const sourceChildren = childrenOf(source);
    const destinationChildren = childrenOf(destination);
    const sourceIndex = directChild(source, globalId(operation.nodeId, 'nodeId'));
    if (sourceChildren === null || destinationChildren === null || sourceIndex < 0
      || !Number.isSafeInteger(operation.destinationIndex) || operation.destinationIndex < 0) invalidInput('destinationIndex');
    let ancestor = index.get(destination.id);
    while (ancestor !== undefined) {
      if (ancestor.node.id === operation.nodeId) invalidInput('destinationParentNodeId');
      ancestor = ancestor.parent === null ? undefined : index.get(ancestor.parent.id);
    }
    const [entry] = sourceChildren.splice(sourceIndex, 1);
    if (operation.destinationIndex > destinationChildren.length) invalidInput('destinationIndex');
    destinationChildren.splice(operation.destinationIndex, 0, placementEntry(destination, entry.node, operation.placement));
    return;
  }
  const layoutChange = {
    set_split_weight: ['splitNodeId', 'layout.split', 'weight', ['weight']],
    set_grid_placement: ['gridNodeId', 'layout.grid', 'column', ['column', 'row', 'columnSpan', 'rowSpan']],
    set_canvas_rect: ['canvasNodeId', 'layout.canvas', 'x', ['x', 'y', 'width', 'height', 'zIndex']],
  }[operation.type];
  if (layoutChange !== undefined) {
    const [parentField, parentType, firstValue, valueFields] = layoutChange;
    assertExactInput(operation, ['type', parentField, 'childNodeId', ...valueFields]);
    const parent = index.get(globalId(operation[parentField], parentField))?.node;
    const childIndex = directChild(parent, globalId(operation.childNodeId, 'childNodeId'));
    if (parent?.type !== parentType || childIndex < 0
      || valueFields.some((field) => typeof operation[field] !== 'number' || !Number.isFinite(operation[field]))) invalidInput(firstValue);
    Object.assign(childrenOf(parent)[childIndex], Object.fromEntries(valueFields.map((field) => [field, operation[field]])));
    return;
  }
  if (operation.type === 'set_active_tab') {
    assertExactInput(operation, ['type', 'tabsNodeId', 'tabId']);
    const parent = index.get(globalId(operation.tabsNodeId, 'tabsNodeId'))?.node;
    if (parent?.type !== 'layout.tabs' || !Array.isArray(parent.tabs) || !LOCAL_ID_PATTERN.test(operation.tabId)
      || !parent.tabs.some((tab) => tab.tabId === operation.tabId)) invalidInput('tabId');
    parent.activeTabId = operation.tabId;
    return;
  }
  if (operation.type === 'upsert_drawing_element') {
    assertExactInput(operation, ['type', 'drawingNodeId', 'element']);
    const node = index.get(globalId(operation.drawingNodeId, 'drawingNodeId'))?.node;
    if (node?.type !== 'content.drawing' || !Array.isArray(node.elements) || !isRecord(operation.element)
      || typeof operation.element.id !== 'string' || !LOCAL_ID_PATTERN.test(operation.element.id)) invalidInput('element');
    const elementIndex = node.elements.findIndex((element) => element.id === operation.element.id);
    if (elementIndex < 0) node.elements.push(structuredClone(operation.element));
    else node.elements[elementIndex] = structuredClone(operation.element);
    return;
  }
  if (operation.type === 'remove_drawing_element') {
    assertExactInput(operation, ['type', 'drawingNodeId', 'elementId']);
    const node = index.get(globalId(operation.drawingNodeId, 'drawingNodeId'))?.node;
    const elementIndex = node?.type === 'content.drawing' && Array.isArray(node.elements)
      ? node.elements.findIndex((element) => element.id === operation.elementId)
      : -1;
    if (elementIndex < 0) invalidInput('elementId');
    node.elements.splice(elementIndex, 1);
    return;
  }
  invalidInput('operations');
};

export const applyScenePatch = (scene, operations) => {
  if (!isRecord(scene) || scene.protocolVersion !== 1 || scene.type !== 'scene' || !('root' in scene)
    || !Array.isArray(operations) || operations.length < 1 || operations.length > 1_000) invalidInput('operations');
  const working = structuredClone(scene);
  for (const operation of operations) applyPatchOperation(working, operation);
  buildNodeIndex(working.root);
  return working;
};

const authorizedRequest = async (config, credential, options) => {
  try {
    return await requestJson({
      config,
      ...options,
      authorization: `Bearer ${credential.accessToken}`,
    });
  } catch (error) {
    if (error instanceof SceneBoardApiError && error.code === 'UNAUTHENTICATED') {
      try {
        await deleteCredentialIfGeneration(config, credential.generation);
      } catch {}
    }
    throw error;
  }
};

export const invokeProtected = async (operation, input, { cwd, env, fetchImpl } = {}) => {
  const config = await resolveApiConfig({ cwd, env });
  const requestId = randomBytes(16).toString('base64url');
  if (operation === 'board_connection_status') return connectionStatus(input, { config, requestId, fetchImpl });
  if (operation === 'board_scene_patch') return invokeScenePatch(input, { config, requestId, fetchImpl });
  const credential = await readCredential(config);
  if (credential === null) {
    throw new SceneBoardApiError('BOARD_API_NOT_CONNECTED', 'SceneBoard API fallback is not paired', {
      details: { recovery: 'run_pair' },
    });
  }
  const spec = protectedSpec(operation, input, requestId);
  const envelope = await authorizedRequest(config, credential, {
    ...spec,
    requestId,
    allowedErrorCodes: OPERATION_ERROR_CODES[operation],
    expectedStatus: spec.expectedType === 'board.create' ? [200, 201] : [200],
    timeoutMs: spec.minimumTimeoutMs === undefined ? undefined : Math.max(config.timeoutMs, spec.minimumTimeoutMs),
    fetchImpl,
  });
  return { requestId, result: envelope.result, metadata: envelope.metadata };
};

const connectionStatus = async (input, { config, requestId, fetchImpl }) => {
  assertExactInput(input, ['boardId']);
  if (input.boardId !== null) globalId(input.boardId, 'boardId');
  const credential = await readCredential(config);
  const safeConfig = { source: config.source, profile: config.profile, baseOrigin: config.baseUrl, timeoutMs: config.timeoutMs, hasToken: credential !== null };
  if (credential === null) return { requestId, result: { state: 'credential_missing', config: safeConfig, connection: null, lastErrorCode: null }, metadata: null };
  const query = new URLSearchParams({ requestId });
  if (input.boardId !== null) query.set('boardId', input.boardId);
  try {
    const result = await requestJson({
      config,
      path: `/api/v1/mcp/connection?${query}`,
      authorization: `Bearer ${credential.accessToken}`,
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: OPERATION_ERROR_CODES.board_connection_status,
      requirePairingHeaders: 'connection',
      connectionBoardId: input.boardId,
      fetchImpl,
    });
    return {
      requestId,
      result: {
        state: 'connected',
        config: safeConfig,
        connection: result,
        lastErrorCode: null,
      },
      metadata: null,
    };
  } catch (error) {
    if (error instanceof SceneBoardApiError && error.code === 'UNAUTHENTICATED') {
      let deleted = false;
      try {
        deleted = await deleteCredentialIfGeneration(config, credential.generation);
      } catch {}
      let hasToken = !deleted;
      if (!deleted) {
        try {
          hasToken = await readCredential(config) !== null;
        } catch {
          hasToken = true;
        }
      }
      return { requestId, result: { state: 'credential_invalid', config: { ...safeConfig, hasToken }, connection: null, lastErrorCode: 'UNAUTHENTICATED' }, metadata: null };
    }
    if (error instanceof SceneBoardApiError && error.retryable) {
      return { requestId, result: { state: 'backend_unavailable', config: safeConfig, connection: null, lastErrorCode: error.code }, metadata: null };
    }
    throw error;
  }
};

const invokeScenePatch = async (input, { config, requestId, fetchImpl }) => {
  assertExactInput(input, ['boardId', 'expectedRevisionId', 'idempotencyKey', 'operations']);
  globalId(input.boardId, 'boardId');
  globalId(input.expectedRevisionId, 'expectedRevisionId');
  idempotencyKey(input.idempotencyKey);
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 1_000) invalidInput('operations');
  const operationDeadline = performance.now() + config.timeoutMs;
  const credential = await readCredential(config);
  if (credential === null) throw new SceneBoardApiError('BOARD_API_NOT_CONNECTED', 'SceneBoard API fallback is not paired', { details: { recovery: 'run_pair' } });
  const head = await authorizedRequest(config, credential, {
    path: `/api/v1/boards/${input.boardId}?requestId=${requestId}`,
    requestId,
    expectedStatus: [200],
    expectedType: 'board.get',
    allowedErrorCodes: OPERATION_ERROR_CODES.board_get,
    retryKind: 'read',
    correlation: { boardId: input.boardId },
    operationDeadline,
    fetchImpl,
  });
  const snapshot = head.result?.result?.snapshot;
  if (!isRecord(snapshot) || !isRecord(snapshot.scene) || !isRecord(snapshot.revision)
    || typeof snapshot.revision.revisionId !== 'string') {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', 'SceneBoard response is invalid', { details: { reason: 'schema' } });
  }
  if (snapshot.revision.revisionId !== input.expectedRevisionId) {
    throw new SceneBoardApiError('REVISION_CONFLICT', 'SceneBoard request failed: REVISION_CONFLICT', {
      details: {
        boardId: input.boardId,
        expectedRevisionId: input.expectedRevisionId,
        actualRevisionId: snapshot.revision.revisionId,
        actualRevisionNumber: snapshot.revision.revisionNumber,
        recovery: 'fetch_latest_then_retry',
      },
    });
  }
  const scene = applyScenePatch(snapshot.scene, input.operations);
  const spec = mutationSpec(baseMutation(input, requestId, { type: 'scene.replace', scene }), 'scene.replace');
  const envelope = await authorizedRequest(config, credential, {
    ...spec,
    requestId,
    expectedStatus: [200],
    allowedErrorCodes: OPERATION_ERROR_CODES.board_scene_patch,
    operationDeadline,
    fetchImpl,
  });
  return {
    requestId,
    result: envelope.result,
    metadata: { type: 'scene-transform', transformedFromRevisionId: snapshot.revision.revisionId },
  };
};

export const safeFailure = (error, operation = null) => {
  const failure = error instanceof SceneBoardApiError
    ? error
    : new SceneBoardApiError('BOARD_API_INTERNAL_ERROR', 'SceneBoard API fallback failed', {
      details: { incidentId: randomBytes(16).toString('base64url') },
    });
  return {
    ok: false,
    transport: 'api',
    operation,
    error: {
      code: failure.code,
      message: safeText(failure.message) && !containsSecretValue(failure.message)
        ? failure.message : 'SceneBoard API fallback failed',
      retryable: failure.retryable,
      details: sanitizePublicValue(failure.details),
    },
  };
};

export const publicConfig = (config) => ({
  source: config.source,
  profile: config.profile,
  baseOrigin: config.baseUrl,
  timeoutMs: config.timeoutMs,
});
