import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const PRODUCTION_API_URL = 'https://sceneboard.dev';
export const SERVER_NAME = 'sceneboard';

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

const normalizeStdioServer = (value, source, environment = {}) => {
  if (!isRecord(value)) throw new TypeError(`invalid_sceneboard_${source}_server`);
  if ('url' in value || value.type === 'http' || value.type === 'streamable-http') {
    throw new TypeError(`unsupported_sceneboard_${source}_transport`);
  }
  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    throw new TypeError(`invalid_sceneboard_${source}_command`);
  }
  const args = stringArray(value.args, `${source}_args`);
  const envVars = stringArray(value.env_vars, `${source}_env_vars`);
  if (envVars.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new TypeError(`invalid_sceneboard_${source}_env_vars`);
  }
  if (isRecursiveLauncher(value.command, args)) return null;
  if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') {
    throw new TypeError(`invalid_sceneboard_${source}_cwd`);
  }
  const env = stringRecord(value.env, `${source}_env`);
  for (const name of envVars) {
    if (typeof environment[name] === 'string') env[name] = environment[name];
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

export const readProjectRootServer = async ({
  projectRoot,
  environment = process.env,
  read = readFile,
}) => {
  const configPath = join(projectRoot, '.mcp.json');
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new TypeError('invalid_sceneboard_project_config_file');
  }
  let text;
  try {
    text = await read(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
    throw new TypeError('invalid_sceneboard_project_config_size');
  const document = parseJson(text, 'project');
  if (!isRecord(document) || !isRecord(document.mcpServers))
    throw new TypeError('invalid_sceneboard_project_config');
  if (!(SERVER_NAME in document.mcpServers)) return null;
  const server = normalizeStdioServer(document.mcpServers[SERVER_NAME], 'project', environment);
  return server === null ? null : { source: 'project_root_mcp_json', server };
};

export const readCodexServer = ({ projectRoot, environment = process.env, run = spawnSync }) => {
  const result = run(environment.CODEX_BINARY ?? 'codex', ['mcp', 'get', SERVER_NAME, '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const document = parseJson(result.stdout, 'codex');
  if (!isRecord(document) || document.name !== SERVER_NAME)
    throw new TypeError('invalid_sceneboard_codex_config');
  if (document.enabled === false) throw new TypeError('disabled_sceneboard_codex_config');
  if (!isRecord(document.transport) || document.transport.type !== 'stdio') {
    throw new TypeError('unsupported_sceneboard_codex_transport');
  }
  const server = normalizeStdioServer(document.transport, 'codex', environment);
  return server === null ? null : { source: 'codex_config_toml', server };
};

export const productionServer = ({ pluginRoot, productionApiUrl = PRODUCTION_API_URL }) => {
  const parsedUrl = new URL(productionApiUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new TypeError('invalid_sceneboard_production_api_url');
  }
  return {
    source: 'production_default',
    server: {
      command: process.execPath,
      args: [join(pluginRoot, 'runtime', 'index.js')],
      cwd: pluginRoot,
      env: {
        BOARD_API_URL: parsedUrl.origin,
        BOARD_ACCESS_TOKEN_REF: 'store://sceneboard',
        BOARD_PROFILE: 'sceneboard',
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
  const project = await readProjectRootServer({ projectRoot, environment, read });
  if (project !== null) return project;
  const codex = readCodexServer({ projectRoot, environment, run });
  if (codex !== null) return codex;
  return productionServer({
    pluginRoot,
    productionApiUrl:
      productionApiUrl ?? environment.SCENEBOARD_PRODUCTION_API_URL ?? PRODUCTION_API_URL,
  });
};
