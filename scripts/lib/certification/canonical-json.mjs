import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export class CertificationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CertificationError';
    this.code = code;
  }
}

const compareCodePoints = (left, right) => {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

export const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CertificationError('NON_JSON_VALUE');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new CertificationError('NON_JSON_VALUE');
  const entries = Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const canonicalJsonSha256 = (value) => sha256(canonicalJson(value));

const CONTEXTUAL_CONTAINER_PATTERN =
  /(?:^|[{\s,])["']?(?:proof|generation)["']?\s*[:=]\s*([[{])/gimu;
const SECRET_SHAPED_FRAGMENT_PATTERN =
  /(?:^|[\s:[{,=])["']?[A-Za-z0-9_-]{22,43}["']?(?=$|[\s,\]};])/mu;
const containsNestedContextualSecret = (text) => {
  CONTEXTUAL_CONTAINER_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CONTEXTUAL_CONTAINER_PATTERN)) {
    const start = match.index + match[0].lastIndexOf(match[1]);
    const stack = [match[1]];
    let quote = null;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          if (SECRET_SHAPED_FRAGMENT_PATTERN.test(text.slice(start + 1, index))) return true;
          break;
        }
      }
    }
  }
  return false;
};

export const containsSecretLikeMaterial = (text) =>
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text) ||
  /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(text) ||
  /\blcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/u.test(text) ||
  /\b(?:Bearer|PairingProof)\s+[A-Za-z0-9._-]{16,}\b/iu.test(text) ||
  /\b[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}\b/iu.test(text) ||
  /(?:^|[{\s,])["']?(?:proof|generation)["']?\s*[:=]\s*(?:["'][A-Za-z0-9_-]{22,43}["']|[A-Za-z0-9_-]{22,43})(?=$|[\s,;}])/imu.test(
    text,
  ) ||
  containsNestedContextualSecret(text) ||
  /(?:^|[\s"'(=])\/(?:[^/\s"'`]+\/)*leecat-board\/credentials\/[A-Za-z0-9_-]+(?:\/[^\s"'`]*)?/u.test(
    text,
  ) ||
  /[A-Za-z]:\\[^\r\n"']*\\leecat-board\\credentials\\[A-Za-z0-9_-]+/u.test(text);

export const assertExactKeys = (value, expected, code = 'UNKNOWN_FIELDS') => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CertificationError(code);
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new CertificationError(code);
};

export const readJson = async (path) => {
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new CertificationError('INVALID_JSON_BYTES');
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new CertificationError('INVALID_JSON_BYTES');
  }
};

export const resolveInside = (root, path, code = 'PATH_ESCAPE') => {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    isAbsolute(path) ||
    normalize(path) !== path
  ) {
    throw new CertificationError(code);
  }
  const absolute = resolve(root, path);
  const offset = relative(root, absolute);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))
    throw new CertificationError(code);
  return absolute;
};

export const safeResult = (status, details = {}) => ({
  schemaVersion: 1,
  status,
  ...details,
});
