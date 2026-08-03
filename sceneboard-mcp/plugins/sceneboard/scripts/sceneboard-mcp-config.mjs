import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const PRODUCTION_API_URL = 'https://sceneboard.dev';
export const SERVER_NAME = 'sceneboard';

const ACCOUNT_API_KEY_PATTERN = /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const RESERVED_API_KEY_NAME = 'SCENEBOARD_API_KEY';
const CODEX_RESOLVER_ENVIRONMENT_NAMES = new Set([
  'APPDATA',
  'CODEX_HOME',
  'COMSPEC',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const CONFIG_RESOLUTION_FAILURE_CODES_V1 = new Set([
  'disabled_sceneboard_codex_config',
  'invalid_sceneboard_codex_args',
  'invalid_sceneboard_codex_command',
  'invalid_sceneboard_codex_config',
  'invalid_sceneboard_codex_cwd',
  'invalid_sceneboard_codex_env',
  'invalid_sceneboard_codex_env_vars',
  'invalid_sceneboard_codex_json',
  'invalid_sceneboard_codex_raw_api_key',
  'invalid_sceneboard_codex_server',
  'invalid_sceneboard_access_token_ref',
  'invalid_sceneboard_credential_mode',
  'invalid_sceneboard_production_api_url',
  'invalid_sceneboard_profile',
  'invalid_sceneboard_project_args',
  'invalid_sceneboard_project_command',
  'invalid_sceneboard_project_config',
  'invalid_sceneboard_project_config_file',
  'invalid_sceneboard_project_config_size',
  'invalid_sceneboard_project_cwd',
  'invalid_sceneboard_project_env',
  'invalid_sceneboard_project_env_vars',
  'invalid_sceneboard_project_json',
  'invalid_sceneboard_project_raw_api_key',
  'invalid_sceneboard_project_server',
  'recursive_sceneboard_launcher',
  'sceneboard_codex_resolution_failed',
  'sceneboard_project_config_read_failed',
  'sceneboard_project_config_stat_failed',
  'unsupported_sceneboard_codex_transport',
  'unsupported_sceneboard_project_transport',
]);

export const configResolutionFailureCodeV1 = (failure) =>
  failure instanceof Error && CONFIG_RESOLUTION_FAILURE_CODES_V1.has(failure.message)
    ? failure.message
    : 'config_resolution_failed';

export const sceneBoardLaunchFailureLineV1 = (code) =>
  `${JSON.stringify({ event: 'sceneboard_mcp_launch_failed', code, setupUrl: 'https://sceneboard.dev/integrations/codex' })}\n`;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stringArray = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`invalid_sceneboard_${field}`);
  }
  return [...value];
};

const stringRecord = (value, field) => {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`invalid_sceneboard_${field}`);
  }
  return { ...value };
};

const isRecursiveLauncher = (command, args) =>
  command.includes('launch-sceneboard-mcp.mjs') ||
  args.some((argument) => argument.includes('launch-sceneboard-mcp.mjs'));

const canonicalBootstrapEnvironmentNames = [
  'BOARD_CREDENTIAL_MODE',
  'BOARD_ACCESS_TOKEN_REF',
  'BOARD_PROFILE',
  'SCENEBOARD_API_KEY',
  'SCENEBOARD_ACCESS_TOKEN',
];

const equalStringArrays = (left, right) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const isCanonicalShippedBootstrap = ({
  value,
  source,
  args,
  env,
  envVars,
  projectRoot,
  pluginRoot,
}) => {
  if (
    typeof pluginRoot !== 'string' ||
    value.command !== 'node' ||
    !equalStringArrays(args, ['./scripts/launch-sceneboard-mcp.mjs']) ||
    !equalStringArrays(envVars, canonicalBootstrapEnvironmentNames) ||
    Object.keys(env).length !== 1 ||
    env.SCENEBOARD_PRODUCTION_API_URL !== PRODUCTION_API_URL
  ) {
    return false;
  }
  if (source === 'project') {
    return (
      typeof projectRoot === 'string' &&
      resolve(projectRoot) === resolve(pluginRoot) &&
      value.cwd === '.'
    );
  }
  return (
    source === 'codex' &&
    typeof value.cwd === 'string' &&
    resolve(value.cwd) === resolve(pluginRoot)
  );
};

const normalizeStdioServer = (
  value,
  source,
  environment = {},
  { projectRoot, pluginRoot } = {},
) => {
  if (!isRecord(value)) throw new TypeError(`invalid_sceneboard_${source}_server`);
  if ('url' in value || value.type === 'http' || value.type === 'streamable-http') {
    throw new TypeError(`unsupported_sceneboard_${source}_transport`);
  }
  const allowedKeys = new Set([
    'command',
    'args',
    'cwd',
    'env',
    'env_vars',
    ...(source === 'codex' ? ['type'] : []),
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`invalid_sceneboard_${source}_server`);
  }
  if (source === 'codex' && value.type !== 'stdio') {
    throw new TypeError('unsupported_sceneboard_codex_transport');
  }
  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    throw new TypeError(`invalid_sceneboard_${source}_command`);
  }
  const args = stringArray(value.args, `${source}_args`);
  const envVars = stringArray(value.env_vars, `${source}_env_vars`);
  const env = stringRecord(value.env, `${source}_env`);
  if (envVars.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new TypeError(`invalid_sceneboard_${source}_env_vars`);
  }
  const recursive = isRecursiveLauncher(value.command, args);
  if (recursive) {
    if (
      isCanonicalShippedBootstrap({
        value,
        source,
        args,
        env,
        envVars,
        projectRoot,
        pluginRoot,
      })
    ) {
      return null;
    }
    throw new TypeError('recursive_sceneboard_launcher');
  }
  if (Object.keys(env).some((name) => name.toUpperCase() === RESERVED_API_KEY_NAME)) {
    throw new TypeError(`invalid_sceneboard_${source}_raw_api_key`);
  }
  if (Object.values(env).some((entry) => ACCOUNT_API_KEY_PATTERN.test(entry))) {
    throw new TypeError(`invalid_sceneboard_${source}_raw_api_key`);
  }
  const explicitInheritedApiKey =
    env.BOARD_CREDENTIAL_MODE === 'api_key' &&
    env.BOARD_ACCESS_TOKEN_REF === 'env://SCENEBOARD_API_KEY';
  if (
    envVars.some(
      (name) =>
        name.toUpperCase() === RESERVED_API_KEY_NAME &&
        (name !== RESERVED_API_KEY_NAME || !explicitInheritedApiKey),
    )
  ) {
    throw new TypeError(`invalid_sceneboard_${source}_raw_api_key`);
  }
  if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') {
    throw new TypeError(`invalid_sceneboard_${source}_cwd`);
  }
  for (const name of envVars) {
    if (typeof environment[name] === 'string') env[name] = environment[name];
  }
  if (
    Object.entries(env).some(
      ([name, entry]) => name !== RESERVED_API_KEY_NAME && ACCOUNT_API_KEY_PATTERN.test(entry),
    )
  ) {
    throw new TypeError(`invalid_sceneboard_${source}_raw_api_key`);
  }
  return {
    command: value.command,
    args,
    cwd: value.cwd ?? undefined,
    env,
  };
};

const parseJson = (text, source) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`invalid_sceneboard_${source}_json`);
  }
};

const codexResolverEnvironment = (environment) => {
  const resolverEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = name.toUpperCase();
    if (
      typeof value === 'string' &&
      (CODEX_RESOLVER_ENVIRONMENT_NAMES.has(canonicalName) ||
        /^LC_[A-Z0-9_]+$/u.test(canonicalName)) &&
      !ACCOUNT_API_KEY_PATTERN.test(value)
    ) {
      resolverEnvironment[name] = value;
    }
  }
  return resolverEnvironment;
};

export const readProjectRootServer = async ({
  projectRoot,
  pluginRoot,
  environment = process.env,
  read = readFile,
  stat = lstat,
}) => {
  const configPath = join(projectRoot, '.mcp.json');
  let metadata;
  try {
    metadata = await stat(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new TypeError('sceneboard_project_config_stat_failed');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new TypeError('invalid_sceneboard_project_config_file');
  }
  let text;
  try {
    text = await read(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new TypeError('sceneboard_project_config_read_failed');
  }
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
    throw new TypeError('invalid_sceneboard_project_config_size');
  const document = parseJson(text, 'project');
  if (!isRecord(document) || !isRecord(document.mcpServers))
    throw new TypeError('invalid_sceneboard_project_config');
  if (!(SERVER_NAME in document.mcpServers)) return null;
  const server = normalizeStdioServer(document.mcpServers[SERVER_NAME], 'project', environment, {
    projectRoot,
    pluginRoot,
  });
  return server === null ? null : { source: 'project_root_mcp_json', server };
};

export const readCodexServer = ({
  projectRoot,
  pluginRoot,
  environment = process.env,
  run = spawnSync,
}) => {
  const executable = environment.CODEX_BINARY ?? 'codex';
  let result;
  try {
    result = run(executable, ['mcp', 'get', SERVER_NAME, '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: codexResolverEnvironment(environment),
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new TypeError('sceneboard_codex_resolution_failed');
  }
  const absentMessage = `Error: No MCP server named '${SERVER_NAME}' found.`;
  const conclusivelyAbsent =
    isRecord(result) &&
    result.error === undefined &&
    result.status === 1 &&
    result.signal === null &&
    result.stdout === '' &&
    (result.stderr === absentMessage ||
      result.stderr === `${absentMessage}\n` ||
      result.stderr === `${absentMessage}\r\n`);
  if (conclusivelyAbsent) return null;
  if (
    !isRecord(result) ||
    result.error !== undefined ||
    result.status !== 0 ||
    (result.signal !== undefined && result.signal !== null) ||
    typeof result.stdout !== 'string'
  ) {
    throw new TypeError('sceneboard_codex_resolution_failed');
  }
  const document = parseJson(result.stdout, 'codex');
  if (!isRecord(document) || document.name !== SERVER_NAME)
    throw new TypeError('invalid_sceneboard_codex_config');
  if (document.enabled === false) throw new TypeError('disabled_sceneboard_codex_config');
  if (!isRecord(document.transport) || document.transport.type !== 'stdio') {
    throw new TypeError('unsupported_sceneboard_codex_transport');
  }
  const server = normalizeStdioServer(document.transport, 'codex', environment, {
    projectRoot,
    pluginRoot,
  });
  return server === null ? null : { source: 'codex_config_toml', server };
};

export const productionServer = ({
  pluginRoot,
  productionApiUrl = PRODUCTION_API_URL,
  environment = process.env,
}) => {
  const parsedUrl = new URL(productionApiUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new TypeError('invalid_sceneboard_production_api_url');
  }
  const credentialMode = environment.BOARD_CREDENTIAL_MODE ?? 'pairing';
  if (credentialMode !== 'pairing' && credentialMode !== 'api_key') {
    throw new TypeError('invalid_sceneboard_credential_mode');
  }
  const profile = environment.BOARD_PROFILE ?? 'sceneboard';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(profile)) {
    throw new TypeError('invalid_sceneboard_profile');
  }
  const accessTokenRef =
    environment.BOARD_ACCESS_TOKEN_REF ??
    (credentialMode === 'api_key' ? 'env://SCENEBOARD_API_KEY' : `store://${profile}`);
  const acceptedReferences = new Set([
    credentialMode === 'api_key' ? 'env://SCENEBOARD_API_KEY' : 'env://SCENEBOARD_ACCESS_TOKEN',
    `store://${profile}`,
  ]);
  if (!acceptedReferences.has(accessTokenRef)) {
    throw new TypeError('invalid_sceneboard_access_token_ref');
  }
  return {
    source: 'production_default',
    server: {
      command: process.execPath,
      args: [join(pluginRoot, 'runtime', 'index.js')],
      cwd: pluginRoot,
      env: {
        BOARD_API_URL: parsedUrl.origin,
        BOARD_CREDENTIAL_MODE: credentialMode,
        BOARD_ACCESS_TOKEN_REF: accessTokenRef,
        BOARD_PROFILE: profile,
        BOARD_TIMEOUT_MS: '30000',
      },
    },
  };
};

export const resolveSceneBoardServer = async ({
  cwd = process.cwd(),
  pluginRoot,
  productionApiUrl,
  environment = process.env,
  read = readFile,
  run = spawnSync,
}) => {
  if (environment.SCENEBOARD_CONFIG_DEPTH === '1')
    throw new TypeError('recursive_sceneboard_launcher');
  const inheritedProjectRoot =
    environment.SCENEBOARD_PROJECT_ROOT ??
    (resolve(cwd) === resolve(pluginRoot) ? environment.PWD : undefined);
  const projectRoot = resolve(inheritedProjectRoot ?? cwd);
  const project = await readProjectRootServer({ projectRoot, pluginRoot, environment, read });
  if (project !== null) return project;
  const codex = readCodexServer({ projectRoot, pluginRoot, environment, run });
  if (codex !== null) return codex;
  return productionServer({
    pluginRoot,
    productionApiUrl:
      productionApiUrl ?? environment.SCENEBOARD_PRODUCTION_API_URL ?? PRODUCTION_API_URL,
    environment,
  });
};
