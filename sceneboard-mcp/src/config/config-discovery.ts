import { access, open } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import {
  BOARD_CONFIG_MAX_BYTES_V1,
  BoardConfigError,
  parseBoardConfigV1,
  readBoardConfigFileV1,
  type LoadedBoardConfigV1,
  type SafeConfigSourceV1,
} from './board-config.js';

const IMPLICIT_REPOSITORY_BASE_URLS_V1 = new Set(['https://sceneboard.dev']);

export type BoardConfigDiscoveryOptionsV1 = {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  effectiveUserId?: number;
};

const processConfigPath = (argv: readonly string[]): string | null => {
  const entries = argv.filter((argument) => argument.startsWith('--config='));
  if (entries.length > 1) throw new BoardConfigError('process_option', null);
  if (entries.length === 0) return null;
  const path = entries[0]?.slice('--config='.length) ?? '';
  if (!isAbsolute(path)) throw new BoardConfigError('process_option', null);
  return path;
};

const nearestBoardFile = async (cwd: string): Promise<string | null> => {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, '.board.json');
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) return null;
      current = parent;
    }
  }
};

const userConfigPath = (env: NodeJS.ProcessEnv): string | null => {
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '') {
    if (!isAbsolute(env.XDG_CONFIG_HOME)) throw new BoardConfigError('user_config_file', null);
    return join(env.XDG_CONFIG_HOME, 'leecat-board', 'board.json');
  }
  if (env.HOME === undefined || env.HOME === '' || !isAbsolute(env.HOME)) return null;
  return join(env.HOME, '.config', 'leecat-board', 'board.json');
};

const existing = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const environmentTimeout = (value: string | undefined): number => {
  if (value === undefined || value === '') return 30_000;
  return /^\d+$/u.test(value) ? Number(value) : Number.NaN;
};

const assertSafeFile = (
  status: BigIntStats,
  source: SafeConfigSourceV1,
  effectiveUserId?: number,
): void => {
  if (
    !status.isFile() ||
    status.nlink !== 1n ||
    status.size < 1n ||
    status.size > BigInt(BOARD_CONFIG_MAX_BYTES_V1) ||
    (status.mode & 0o022n) !== 0n
  ) {
    throw new BoardConfigError(source, null);
  }
  if (effectiveUserId === undefined || status.uid !== BigInt(effectiveUserId))
    throw new BoardConfigError(source, null);
};

const loadFile = async (
  path: string,
  source: SafeConfigSourceV1,
  effectiveUserId?: number,
): Promise<LoadedBoardConfigV1> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const approvedStatus = await handle.stat({ bigint: true });
    assertSafeFile(approvedStatus, source, effectiveUserId);
    const config = await readBoardConfigFileV1(handle, source, approvedStatus);
    if (source === 'nearest_board_file' && !IMPLICIT_REPOSITORY_BASE_URLS_V1.has(config.baseUrl))
      throw new BoardConfigError(source, 'baseUrl');
    return { config, source, path };
  } catch (error) {
    if (error instanceof BoardConfigError) throw error;
    throw new BoardConfigError(source, null);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const discoverBoardConfigV1 = async (
  options: BoardConfigDiscoveryOptionsV1,
): Promise<LoadedBoardConfigV1> => {
  const effectiveUserId = options.effectiveUserId ?? process.geteuid?.();
  const processPath = processConfigPath(options.argv);
  if (processPath !== null) return loadFile(processPath, 'process_option', effectiveUserId);

  if (options.env.BOARD_CONFIG !== undefined && options.env.BOARD_CONFIG !== '') {
    if (!isAbsolute(options.env.BOARD_CONFIG)) throw new BoardConfigError('board_config_env', null);
    return loadFile(options.env.BOARD_CONFIG, 'board_config_env', effectiveUserId);
  }

  const nearest = await nearestBoardFile(options.cwd);
  if (nearest !== null) return loadFile(nearest, 'nearest_board_file', effectiveUserId);

  const userPath = userConfigPath(options.env);
  if (userPath !== null && (await existing(userPath)))
    return loadFile(userPath, 'user_config_file', effectiveUserId);

  if (options.env.BOARD_API_URL === undefined || options.env.BOARD_API_URL === '') {
    throw new BoardConfigError('environment', 'baseUrl');
  }
  const config = parseBoardConfigV1(
    {
      version: 1,
      baseUrl: options.env.BOARD_API_URL,
      accessTokenRef:
        options.env.BOARD_ACCESS_TOKEN_REF ??
        (options.env.BOARD_CREDENTIAL_MODE === 'api_key'
          ? 'env://SCENEBOARD_API_KEY'
          : 'env://SCENEBOARD_ACCESS_TOKEN'),
      authScheme: 'bearer',
      timeoutMs: environmentTimeout(options.env.BOARD_TIMEOUT_MS),
      profile: options.env.BOARD_PROFILE ?? 'default',
      ...(options.env.BOARD_CREDENTIAL_MODE === undefined
        ? {}
        : { credentialMode: options.env.BOARD_CREDENTIAL_MODE }),
    },
    'environment',
  );
  return { config, source: 'environment', path: null };
};
