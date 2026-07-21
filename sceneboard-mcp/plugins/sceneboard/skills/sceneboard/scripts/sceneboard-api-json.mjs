import { SceneBoardApiError } from './sceneboard-api-error.mjs';

const SUCCESS_BODY_LIMIT = 2_097_152;

export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const hasExactKeys = (value, keys) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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

export const parseJsonBytes = (bytes, label, maximum = SUCCESS_BODY_LIMIT) => {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, {
      details: { reason: 'body_size' },
    });
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, {
      details: { reason: 'utf8' },
    });
  }
  if (hasDuplicateJsonMember(source)) {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, {
      details: { reason: 'duplicate_member' },
    });
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new SceneBoardApiError('BOARD_API_RESPONSE_INVALID', `${label} is invalid`, {
      details: { reason: 'json' },
    });
  }
};
