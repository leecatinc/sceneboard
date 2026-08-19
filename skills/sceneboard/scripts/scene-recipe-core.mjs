import { createHash } from 'node:crypto';
import {
  LIMITS_V1,
  canonicalizeJsonValue,
  serializeCanonicalJson,
  validatePlainJson,
} from './scene-recipe-validation-internal.mjs';
import {
  createSceneRecipeCompiler,
  SCENE_RECIPE_BLOCK_KINDS_INTERNAL,
} from './scene-recipe-compiler-internal.mjs';

export const SCENE_RECIPE_VERSION = 1;

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const SCENE_RECIPE_LIMITS_V1 = deepFreeze({ ...LIMITS_V1 });
export const SCENE_RECIPE_BLOCK_KINDS_V1 = Object.freeze([...SCENE_RECIPE_BLOCK_KINDS_INTERNAL]);

const MESSAGES = Object.freeze({
  INVALID_JSON: 'Scene Recipe JSON is invalid.',
  INVALID_RECIPE: 'Scene Recipe is invalid.',
  UNSUPPORTED_RECIPE_VERSION: 'Scene Recipe version is unsupported.',
  UNKNOWN_FIELD: 'Scene Recipe contains an unknown field.',
  UNKNOWN_BLOCK_KIND: 'Scene Recipe block kind is unsupported.',
  INVALID_VALUE: 'Scene Recipe value is invalid.',
  LIMIT_EXCEEDED: 'Scene Recipe limit is exceeded.',
  PAYLOAD_TOO_LARGE: 'Scene Recipe payload is too large.',
  INVALID_LAYOUT: 'Scene Recipe layout is invalid.',
  DUPLICATE_SEMANTIC_IDENTITY: 'Scene Recipe semantic identity is duplicated.',
  DUPLICATE_NODE_ID: 'Scene node identity is duplicated.',
  NODE_ID_COLLISION: 'Generated scene node identity collided.',
  INVALID_EXACT_NODE: 'Exact scene node is invalid.',
});

export class SceneRecipeError extends Error {
  constructor(code, path = []) {
    super(MESSAGES[code] ?? MESSAGES.INVALID_RECIPE);
    this.name = 'SceneRecipeError';
    this.code = MESSAGES[code] ? code : 'INVALID_RECIPE';
    this.path = Array.isArray(path) ? [...path] : [];
  }
}

const failPlain = (error) => {
  if (!error) return;
  throw new SceneRecipeError(
    error.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID_JSON',
    error.path,
  );
};

// Reject duplicate JSON object members before JSON.parse. Strings and escapes are
// decoded by JSON.parse; this scanner tracks only structural object key positions.
export const hasDuplicateJsonMembers = (text) => {
  const stack = [];
  let index = 0;
  let expectingKey = false;
  const readString = () => {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index += 1;
      else if (char === '"') return text.slice(start, index);
    }
    return null;
  };
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const raw = readString();
      if (raw === null) return true;
      if (expectingKey && stack.at(-1)?.type === 'object') {
        let key;
        try {
          key = JSON.parse(raw);
        } catch {
          return true;
        }
        const frame = stack.at(-1);
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        let cursor = index;
        while (/\s/.test(text[cursor])) cursor += 1;
        if (text[cursor] === ':') expectingKey = false;
      }
      continue;
    }
    if (char === '{') {
      stack.push({ type: 'object', keys: new Set() });
      expectingKey = true;
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ type: 'array' });
      expectingKey = false;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      expectingKey = stack.at(-1)?.type === 'object' && false;
      index += 1;
      continue;
    }
    if (char === ',') {
      expectingKey = stack.at(-1)?.type === 'object';
      index += 1;
      continue;
    }
    index += 1;
  }
  return false;
};

export const canonicalizeSceneRecipeJson = (value) => {
  failPlain(validatePlainJson(value));
  return canonicalizeJsonValue(value);
};

export const stringifyCanonicalSceneRecipeJson = (value) => {
  failPlain(validatePlainJson(value));
  return serializeCanonicalJson(value);
};

export const slugifySceneRecipeIdentity = (value) => {
  if (typeof value !== 'string') throw new SceneRecipeError('INVALID_VALUE', []);
  const slug = value
    .normalize('NFKD')
    .replace(/[\p{Mn}\p{Mc}\p{Me}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'node';
};

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalPath = (path) => stringifyCanonicalSceneRecipeJson(path);

export const deriveSceneRecipeNodeId = ({ path, nodeKind, key }) => {
  if (
    !Array.isArray(path) ||
    typeof nodeKind !== 'string' ||
    (key !== undefined && typeof key !== 'string')
  )
    throw new SceneRecipeError('INVALID_VALUE', []);
  const digest = sha256(`recipe-v1\n${canonicalPath(path)}\n${nodeKind}\n${key ?? ''}`).slice(
    0,
    12,
  );
  return `n_${slugifySceneRecipeIdentity(key ?? nodeKind)}_${digest}`;
};

const compiler = createSceneRecipeCompiler({
  digest: sha256,
  slugify: slugifySceneRecipeIdentity,
  canonicalPath,
  ErrorType: SceneRecipeError,
});

export const validateSceneRecipe = (input) => {
  failPlain(validatePlainJson(input));
  return canonicalizeSceneRecipeJson(compiler.validate(input));
};

export const compileSceneRecipe = (input) => {
  failPlain(validatePlainJson(input));
  return compiler.compile(input);
};

export const compileSceneRecipeReplaceInput = (input, binding) => {
  failPlain(validatePlainJson(input));
  failPlain(validatePlainJson(binding));
  return compiler.replaceInput(input, binding);
};

export const parseSceneRecipeJson = (bytes) => {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : null;
  if (!buffer) throw new SceneRecipeError('INVALID_JSON', []);
  if (buffer.byteLength > LIMITS_V1.maxEnvelopeBytes)
    throw new SceneRecipeError('PAYLOAD_TOO_LARGE', []);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new SceneRecipeError('INVALID_JSON', []);
  }
  if (hasDuplicateJsonMembers(text)) throw new SceneRecipeError("INVALID_JSON", []);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SceneRecipeError('INVALID_JSON', []);
  }
  return validateSceneRecipe(parsed);
};
