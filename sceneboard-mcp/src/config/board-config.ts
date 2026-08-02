import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export const BOARD_CONFIG_MAX_BYTES_V1 = 65_536;
export const BOARD_PROFILE_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type PairingBoardConfigFileV1 = {
  version: 1;
  baseUrl: string;
  accessTokenRef: 'env://SCENEBOARD_ACCESS_TOKEN' | `store://${string}`;
  authScheme: 'bearer';
  timeoutMs: number;
  profile: string;
  credentialMode?: 'pairing';
};

export type ApiKeyBoardConfigFileV1 = {
  version: 1;
  baseUrl: string;
  accessTokenRef: 'env://SCENEBOARD_API_KEY' | `store://${string}`;
  authScheme: 'bearer';
  timeoutMs: number;
  profile: string;
  credentialMode: 'api_key';
};

export type BoardConfigFileV1 = PairingBoardConfigFileV1 | ApiKeyBoardConfigFileV1;

export type SafeConfigSourceV1 =
  | 'process_option'
  | 'board_config_env'
  | 'nearest_board_file'
  | 'user_config_file'
  | 'environment';

export type LoadedBoardConfigV1 = {
  config: BoardConfigFileV1;
  source: SafeConfigSourceV1;
  path: string | null;
};

export class BoardConfigError extends Error {
  readonly source: SafeConfigSourceV1 | null;
  readonly field: string | null;

  constructor(source: SafeConfigSourceV1 | null, field: string | null) {
    super('Board configuration is invalid');
    this.name = 'BoardConfigError';
    this.source = source;
    this.field = field;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const hasDuplicateJsonMember = (source: string): boolean => {
  const objectKeySets: Set<string>[] = [];
  const containers: ('object' | 'array')[] = [];
  let expectingKey = false;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '"') break;
        index += 1;
      }
      if (index >= source.length) return false;
      if (expectingKey && containers.at(-1) === 'object') {
        let key: unknown;
        try {
          key = JSON.parse(source.slice(start, index + 1));
        } catch {
          return false;
        }
        const keys = objectKeySets.at(-1);
        if (typeof key !== 'string' || keys === undefined) return false;
        if (keys.has(key)) return true;
        keys.add(key);
        expectingKey = false;
      }
      index += 1;
      continue;
    }
    if (character === '{') {
      containers.push('object');
      objectKeySets.push(new Set());
      expectingKey = true;
    } else if (character === '[') {
      containers.push('array');
    } else if (character === '}' || character === ']') {
      const removed = containers.pop();
      if (removed === 'object') objectKeySets.pop();
      expectingKey = false;
    } else if (character === ',' && containers.at(-1) === 'object') {
      expectingKey = true;
    } else if (character === ':' && containers.at(-1) === 'object') {
      expectingKey = false;
    }
    index += 1;
  }
  return false;
};

const parseJsonBytes = (bytes: Uint8Array, source: SafeConfigSourceV1): unknown => {
  if (bytes.byteLength === 0 || bytes.byteLength > BOARD_CONFIG_MAX_BYTES_V1) {
    throw new BoardConfigError(source, null);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BoardConfigError(source, null);
  }
  if (hasDuplicateJsonMember(text)) throw new BoardConfigError(source, null);
  try {
    return JSON.parse(text);
  } catch {
    throw new BoardConfigError(source, null);
  }
};

const canonicalBaseUrl = (value: unknown, source: SafeConfigSourceV1): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    /[<>${}\s]/.test(value) ||
    /example\.(?:com|org|net)$/i.test(value)
  ) {
    throw new BoardConfigError(source, 'baseUrl');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BoardConfigError(source, 'baseUrl');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new BoardConfigError(source, 'baseUrl');
  }
  return url.origin;
};

export const parseBoardConfigV1 = (
  value: unknown,
  source: SafeConfigSourceV1,
): BoardConfigFileV1 => {
  const legacyKeys = ['version', 'baseUrl', 'accessTokenRef', 'authScheme', 'timeoutMs', 'profile'];
  const discriminatedKeys = [...legacyKeys, 'credentialMode'];
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, discriminatedKeys))
  )
    throw new BoardConfigError(source, null);
  if (value.version !== 1) throw new BoardConfigError(source, 'version');
  if (value.authScheme !== 'bearer') throw new BoardConfigError(source, 'authScheme');
  if (
    value.credentialMode !== undefined &&
    value.credentialMode !== 'pairing' &&
    value.credentialMode !== 'api_key'
  )
    throw new BoardConfigError(source, 'credentialMode');
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1_000 ||
    Number(value.timeoutMs) > 120_000
  ) {
    throw new BoardConfigError(source, 'timeoutMs');
  }
  if (typeof value.profile !== 'string' || !BOARD_PROFILE_PATTERN_V1.test(value.profile)) {
    throw new BoardConfigError(source, 'profile');
  }
  const credentialMode = value.credentialMode ?? 'pairing';
  const environmentReference =
    credentialMode === 'api_key' ? 'env://SCENEBOARD_API_KEY' : 'env://SCENEBOARD_ACCESS_TOKEN';
  if (
    value.accessTokenRef !== environmentReference &&
    value.accessTokenRef !== `store://${value.profile}`
  )
    throw new BoardConfigError(source, 'accessTokenRef');
  const base = {
    version: 1 as const,
    baseUrl: canonicalBaseUrl(value.baseUrl, source),
    authScheme: 'bearer' as const,
    timeoutMs: Number(value.timeoutMs),
    profile: value.profile,
  };
  if (credentialMode === 'api_key')
    return {
      ...base,
      accessTokenRef:
        value.accessTokenRef === 'env://SCENEBOARD_API_KEY'
          ? value.accessTokenRef
          : `store://${value.profile}`,
      credentialMode: 'api_key',
    };
  const pairing: PairingBoardConfigFileV1 = {
    ...base,
    accessTokenRef:
      value.accessTokenRef === 'env://SCENEBOARD_ACCESS_TOKEN'
        ? value.accessTokenRef
        : `store://${value.profile}`,
  };
  return value.credentialMode === 'pairing' ? { ...pairing, credentialMode: 'pairing' } : pairing;
};

const sameFileStatus = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const readBoundedFileHandle = async (handle: FileHandle): Promise<Uint8Array> => {
  const buffer = new Uint8Array(BOARD_CONFIG_MAX_BYTES_V1 + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
};

export const readBoardConfigFileV1 = async (
  handle: FileHandle,
  source: SafeConfigSourceV1,
  approvedStatus: BigIntStats,
): Promise<BoardConfigFileV1> => {
  let before: BigIntStats;
  let bytes: Uint8Array;
  let after: BigIntStats;
  try {
    before = await handle.stat({ bigint: true });
    if (!sameFileStatus(approvedStatus, before)) throw new BoardConfigError(source, null);
    bytes = await readBoundedFileHandle(handle);
    after = await handle.stat({ bigint: true });
  } catch {
    throw new BoardConfigError(source, null);
  }
  if (!sameFileStatus(before, after)) throw new BoardConfigError(source, null);
  return parseBoardConfigV1(parseJsonBytes(bytes, source), source);
};
