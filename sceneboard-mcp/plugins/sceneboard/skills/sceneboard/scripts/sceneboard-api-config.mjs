import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { SceneBoardApiError } from './sceneboard-api-error.mjs';
import { hasExactKeys, isRecord, parseJsonBytes } from './sceneboard-api-json.mjs';

const API_DEFAULT = 'https://sceneboard.dev';
const MAX_CONFIG_BYTES = 65_536;
export const TOKEN_PATTERN = /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const API_KEY_PATTERN = /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const GENERATION_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_PROTECTED_VALUE_PATTERN = /^[A-Za-z0-9+/]{16,8192}={0,2}$/;
const WINDOWS_PROTECTION = 'windows-dpapi-current-user';
const WINDOWS_DPAPI_TIMEOUT_MS = 10_000;
const WINDOWS_DPAPI_OUTPUT_LIMIT = 16_384;
const WINDOWS_DPAPI_SCRIPTS = {
  protect:
    'Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))',
  unprotect:
    'Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$protected=[Convert]::FromBase64String($value);$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
};
const PROJECT_ENV_KEYS = [
  'BOARD_ACCESS_TOKEN_REF',
  'BOARD_API_URL',
  'BOARD_PROFILE',
  'BOARD_TIMEOUT_MS',
];
const PROJECT_ENV_KEYS_WITH_MODE = [...PROJECT_ENV_KEYS, 'BOARD_CREDENTIAL_MODE'];

const validateBaseUrl = (value) => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    /[<>${}\s]/u.test(value)
  ) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'baseUrl' } },
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'baseUrl' } },
    );
  }
  const isLoopback = ['127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
  ) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'baseUrl' } },
    );
  }
  return url.origin;
};

const validateProfile = (value) => {
  if (typeof value !== 'string' || !PROFILE_PATTERN.test(value)) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'profile' } },
    );
  }
  return value;
};

const validateTimeout = (value) => {
  const timeoutMs = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'timeoutMs' } },
    );
  }
  return timeoutMs;
};

const isWindows = (platform) => platform === 'win32';

const runWindowsDataProtection = (operation, value) =>
  new Promise((resolve, reject) => {
    const script = WINDOWS_DPAPI_SCRIPTS[operation];
    if (script === undefined || typeof value !== 'string') {
      reject(
        new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard Windows credential protection is unavailable',
        ),
      );
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) {
      reject(
        new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard Windows credential protection is unavailable',
          { details: { reason: 'windows_system_root_unavailable' } },
        ),
      );
      return;
    }
    const powershellPath = join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    let output = '';
    let outputBytes = 0;
    let settled = false;
    const child = spawn(
      powershellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === null) resolve(result);
      else
        reject(
          new SceneBoardApiError(
            'BOARD_API_CREDENTIAL_UNAVAILABLE',
            'SceneBoard Windows credential protection is unavailable',
            { details: { reason: error } },
          ),
        );
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
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid) ||
    (!isWindows(platform) && (status.mode & 0o777) !== 0o600)
  ) {
    throw new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard private state is invalid',
    );
  }
};

const assertPrivateDirectory = async (path, platform = process.platform) => {
  const status = await lstat(path);
  const ownUid = process.geteuid?.();
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid) ||
    (!isWindows(platform) && (status.mode & 0o777) !== 0o700)
  ) {
    throw new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard private state is invalid',
    );
  }
};

const ensurePrivateDirectory = async (path, platform = process.platform) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  const ownUid = process.geteuid?.();
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (!isWindows(platform) && ownUid !== undefined && status.uid !== ownUid)
  ) {
    throw new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard private state is invalid',
    );
  }
  if (!isWindows(platform) && (status.mode & 0o777) !== 0o700) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
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
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
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
      throw new SceneBoardApiError(
        'BOARD_API_CONFIG_INVALID',
        'SceneBoard API configuration is invalid',
        { details: { field: 'LOCALAPPDATA' } },
      );
    }
    return localAppData;
  }
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== '') {
    if (!isAbsolute(env.XDG_STATE_HOME)) {
      throw new SceneBoardApiError(
        'BOARD_API_CONFIG_INVALID',
        'SceneBoard API configuration is invalid',
        { details: { field: 'XDG_STATE_HOME' } },
      );
    }
    return env.XDG_STATE_HOME;
  }
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'HOME' } },
    );
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
  let credentialMode = env.SCENEBOARD_CREDENTIAL_MODE ?? 'pairing';
  const projectConfigPath = join(cwd, '.mcp.json');
  try {
    const status = await lstat(projectConfigPath);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size <= 0 ||
      status.size > MAX_CONFIG_BYTES
    ) {
      throw new SceneBoardApiError(
        'BOARD_API_CONFIG_INVALID',
        'Project SceneBoard configuration is invalid',
      );
    }
    const parsed = parseJsonBytes(
      await readFile(projectConfigPath),
      'Project SceneBoard configuration',
      MAX_CONFIG_BYTES,
    );
    const server = isRecord(parsed?.mcpServers) ? parsed.mcpServers.sceneboard : undefined;
    const selectedEnvironment =
      isRecord(server) &&
      isRecord(server.env) &&
      PROJECT_ENV_KEYS.some((key) => Object.hasOwn(server.env, key));
    if (selectedEnvironment) {
      const hasLegacyPairingTuple = hasExactKeys(server.env, PROJECT_ENV_KEYS);
      const hasCredentialModeTuple = hasExactKeys(server.env, PROJECT_ENV_KEYS_WITH_MODE);
      if (!hasLegacyPairingTuple && !hasCredentialModeTuple) {
        throw new SceneBoardApiError(
          'BOARD_API_CONFIG_INVALID',
          'Project SceneBoard configuration is invalid',
        );
      }
      baseUrl = server.env.BOARD_API_URL;
      profile = server.env.BOARD_PROFILE;
      timeoutMs = server.env.BOARD_TIMEOUT_MS;
      credentialMode = hasCredentialModeTuple ? server.env.BOARD_CREDENTIAL_MODE : 'pairing';
      if (
        typeof profile !== 'string' ||
        !['pairing', 'api_key'].includes(credentialMode) ||
        server.env.BOARD_ACCESS_TOKEN_REF !== `store://${profile}`
      ) {
        throw new SceneBoardApiError(
          'BOARD_API_CONFIG_INVALID',
          'Project SceneBoard configuration is invalid',
        );
      }
      source = 'project_mcp';
    } else {
      if (server !== undefined && (!isRecord(server) || !isRecord(server.env))) {
        throw new SceneBoardApiError(
          'BOARD_API_CONFIG_INVALID',
          'Project SceneBoard configuration is invalid',
        );
      }
      if (
        env.SCENEBOARD_API_URL !== undefined ||
        env.SCENEBOARD_PROFILE !== undefined ||
        env.SCENEBOARD_TIMEOUT_MS !== undefined
      )
        source = 'environment';
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (
      env.SCENEBOARD_API_URL !== undefined ||
      env.SCENEBOARD_PROFILE !== undefined ||
      env.SCENEBOARD_TIMEOUT_MS !== undefined
    )
      source = 'environment';
  }
  const validProfile = validateProfile(profile);
  if (!['pairing', 'api_key'].includes(credentialMode)) {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard API configuration is invalid',
      { details: { field: 'credentialMode' } },
    );
  }
  return {
    baseUrl: validateBaseUrl(baseUrl),
    profile: validProfile,
    timeoutMs: validateTimeout(timeoutMs),
    source,
    platform,
    windowsDataProtection,
    credentialMode,
    stateDirectory: join(stateRoot(env, platform), 'leecat-board', 'credentials', validProfile),
  };
};

export const atomicPrivateWrite = async (
  directory,
  fileName,
  bytes,
  { platform = process.platform } = {},
) => {
  await ensurePrivateDirectory(directory, platform);
  const temporaryPath = join(
    directory,
    `.${fileName}.${randomBytes(16).toString('base64url')}.tmp`,
  );
  const targetPath = join(directory, fileName);
  let handle = null;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (isWindows(platform) ? 0 : constants.O_NOFOLLOW),
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
  const isApiKey = config.credentialMode === 'api_key';
  if (isApiKey && isWindows(config.platform)) {
    throw new SceneBoardApiError(
      'BOARD_API_CREDENTIAL_UNAVAILABLE',
      'SceneBoard API-key private storage is unavailable on Windows',
    );
  }
  const path = join(
    config.stateDirectory,
    isApiKey ? 'api-key.credential.json' : 'credential.json',
  );
  try {
    await ensurePrivateDirectory(config.stateDirectory, config.platform);
    await statRegularPrivateFile(path, config.platform);
    const bytes = await readFile(path);
    const record = parseJsonBytes(bytes, 'SceneBoard credential', 512);
    const source = new TextDecoder().decode(bytes);
    if (isApiKey) {
      if (
        !hasExactKeys(record, ['version', 'generation', 'apiKey']) ||
        record.version !== 1 ||
        typeof record.generation !== 'string' ||
        !GENERATION_PATTERN.test(record.generation) ||
        typeof record.apiKey !== 'string' ||
        !API_KEY_PATTERN.test(record.apiKey) ||
        JSON.stringify(record) !== source
      ) {
        throw new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard credential is invalid',
        );
      }
      return {
        version: 1,
        generation: record.generation,
        accessToken: record.apiKey,
        credentialMode: 'api_key',
      };
    }
    if (isWindows(config.platform)) {
      if (
        !hasExactKeys(record, ['version', 'generation', 'protection', 'protectedAccessToken']) ||
        record.version !== 2 ||
        typeof record.generation !== 'string' ||
        !GENERATION_PATTERN.test(record.generation) ||
        record.protection !== WINDOWS_PROTECTION ||
        typeof record.protectedAccessToken !== 'string' ||
        !WINDOWS_PROTECTED_VALUE_PATTERN.test(record.protectedAccessToken) ||
        JSON.stringify(record) !== source
      ) {
        throw new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard credential is invalid',
        );
      }
      let accessToken;
      try {
        accessToken = await config.windowsDataProtection.unprotect(record.protectedAccessToken);
      } catch (error) {
        if (error instanceof SceneBoardApiError) throw error;
        throw new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard Windows credential protection is unavailable',
        );
      }
      if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken)) {
        throw new SceneBoardApiError(
          'BOARD_API_CREDENTIAL_UNAVAILABLE',
          'SceneBoard credential is invalid',
        );
      }
      return { version: 1, generation: record.generation, accessToken, credentialMode: 'pairing' };
    }
    if (
      !hasExactKeys(record, ['version', 'generation', 'accessToken']) ||
      record.version !== 1 ||
      typeof record.generation !== 'string' ||
      !GENERATION_PATTERN.test(record.generation) ||
      typeof record.accessToken !== 'string' ||
      !TOKEN_PATTERN.test(record.accessToken) ||
      JSON.stringify(record) !== source
    ) {
      throw new SceneBoardApiError(
        'BOARD_API_CREDENTIAL_UNAVAILABLE',
        'SceneBoard credential is invalid',
      );
    }
    return { ...record, credentialMode: 'pairing' };
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
      handle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (isWindows(config.platform) ? 0 : constants.O_NOFOLLOW),
        0o600,
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === 39) {
        throw new SceneBoardApiError(
          'BOARD_API_PROFILE_BUSY',
          'SceneBoard credential profile is busy',
          {
            retryable: true,
            details: { recovery: 'retry_after_current_credential_update' },
          },
        );
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
      if (
        hasExactKeys(value, ['version', 'nonce']) &&
        value.version === 1 &&
        value.nonce === nonce
      ) {
        await unlink(path);
        await syncDirectory(config.stateDirectory, config.platform);
      }
    } catch {
      // Cleanup is best-effort after the protected operation has completed.
    }
  };
};

export const writeCredential = async (config, accessToken) => {
  if (config.credentialMode === 'api_key') {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard pairing is unavailable in API-key mode',
    );
  }
  if (!TOKEN_PATTERN.test(accessToken)) {
    throw new SceneBoardApiError(
      'BOARD_API_RESPONSE_INVALID',
      'SceneBoard pairing response is invalid',
    );
  }
  const generation = randomBytes(16).toString('base64url');
  let record;
  if (isWindows(config.platform)) {
    let protectedAccessToken;
    try {
      protectedAccessToken = await config.windowsDataProtection.protect(accessToken);
    } catch (error) {
      if (error instanceof SceneBoardApiError) throw error;
      throw new SceneBoardApiError(
        'BOARD_API_CREDENTIAL_UNAVAILABLE',
        'SceneBoard Windows credential protection is unavailable',
      );
    }
    if (
      typeof protectedAccessToken !== 'string' ||
      !WINDOWS_PROTECTED_VALUE_PATTERN.test(protectedAccessToken)
    ) {
      throw new SceneBoardApiError(
        'BOARD_API_CREDENTIAL_UNAVAILABLE',
        'SceneBoard Windows credential protection is unavailable',
      );
    }
    record = { version: 2, generation, protection: WINDOWS_PROTECTION, protectedAccessToken };
  } else record = { version: 1, generation, accessToken };
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const release = await acquireCredentialMutationLock(config);
  try {
    await atomicPrivateWrite(config.stateDirectory, 'credential.json', bytes, {
      platform: config.platform,
    });
  } finally {
    bytes.fill(0);
    await release();
  }
  return generation;
};

export const deleteCredentialIfGeneration = async (config, generation) => {
  if (config.credentialMode === 'api_key') return false;
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) return false;
  const release = await acquireCredentialMutationLock(config);
  const path = join(config.stateDirectory, 'credential.json');
  try {
    await ensurePrivateDirectory(config.stateDirectory, config.platform);
    await statRegularPrivateFile(path, config.platform);
    const current = await readCredential(config);
    if (current === null || current.generation !== generation) return false;
    const quarantine = join(
      config.stateDirectory,
      `.credential.quarantine.${randomBytes(16).toString('base64url')}`,
    );
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
    if (
      !hasExactKeys(record, ['version', 'installationId']) ||
      record.version !== 1 ||
      typeof record.installationId !== 'string' ||
      !/^[A-Za-z0-9._:-]{16,128}$/u.test(record.installationId) ||
      JSON.stringify(record) !== new TextDecoder().decode(bytes)
    ) {
      throw new SceneBoardApiError(
        'BOARD_API_CREDENTIAL_UNAVAILABLE',
        'SceneBoard installation identity is invalid',
      );
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
    handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (isWindows(config.platform) ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new SceneBoardApiError(
        'BOARD_API_PROFILE_BUSY',
        'SceneBoard API fallback pairing is already active',
        {
          retryable: true,
          details: { recovery: 'finish_or_stop_existing_api_pairing' },
        },
      );
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
    } catch {
      // Cleanup is best-effort after the protected operation has completed.
    }
  };
};
