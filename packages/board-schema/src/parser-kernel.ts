import type { z } from 'zod';

import {
  compareUnicodeScalarsV1,
  hasLoneSurrogateV1,
  serializeJsonNumberV1,
  serializeJsonStringV1,
  type JsonValue,
} from './json.js';
import {
  MAX_ENVELOPE_BYTES,
  MAX_JSON_CONTAINER_ENTRIES,
  MAX_JSON_DEPTH,
} from './limits.js';

export type KernelPathV1 = Array<string | number>;
export type KernelIssueKindV1 =
  | 'invalid_json'
  | 'json_depth'
  | 'json_container_entries'
  | 'payload_too_large'
  | 'schema';
export type KernelIssueV1 = {
  kind: KernelIssueKindV1;
  path: KernelPathV1;
  message: string;
  actual?: number;
  maximum?: number;
};
export type KernelResultV1<T> =
  | { ok: true; value: T; canonicalBytes: Uint8Array }
  | { ok: false; issue: KernelIssueV1 };

type VisitFrame = {
  value: unknown;
  path: KernelPathV1;
  depth: number;
  exiting?: boolean;
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validateJsonValueV1 = (input: unknown): KernelResultV1<JsonValue> => {
  const active = new WeakSet<object>();
  const stack: VisitFrame[] = [{ value: input, path: [], depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { value, path, depth } = frame;
    if (frame.exiting && typeof value === 'object' && value !== null) {
      active.delete(value);
      continue;
    }
    if (depth > MAX_JSON_DEPTH) {
      return { ok: false, issue: { kind: 'json_depth', path, message: 'JSON depth exceeded', actual: depth, maximum: MAX_JSON_DEPTH } };
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, issue: { kind: 'invalid_json', path, message: 'number must be finite' } };
      continue;
    }
    if (typeof value === 'string') {
      if (hasLoneSurrogateV1(value)) return { ok: false, issue: { kind: 'invalid_json', path, message: 'lone surrogate is not allowed' } };
      continue;
    }
    if (typeof value !== 'object') return { ok: false, issue: { kind: 'invalid_json', path, message: 'value is not JSON' } };
    if (active.has(value)) return { ok: false, issue: { kind: 'invalid_json', path, message: 'cyclic values are not allowed' } };
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { ok: false, issue: { kind: 'invalid_json', path, message: 'symbol keys are not allowed' } };
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return { ok: false, issue: { kind: 'invalid_json', path, message: 'object must have a plain prototype' } };
    }
    const keys = Object.keys(value);
    const ownStringKeys = Object.getOwnPropertyNames(value).filter((key) => !Array.isArray(value) || key !== 'length');
    if (ownStringKeys.length !== keys.length) {
      return { ok: false, issue: { kind: 'invalid_json', path, message: 'non-enumerable properties are not allowed' } };
    }
    if (keys.length > MAX_JSON_CONTAINER_ENTRIES) {
      return { ok: false, issue: { kind: 'json_container_entries', path, message: 'JSON container entries exceeded', actual: keys.length, maximum: MAX_JSON_CONTAINER_ENTRIES } };
    }
    if (Array.isArray(value) && keys.length !== value.length) {
      return { ok: false, issue: { kind: 'invalid_json', path, message: 'sparse arrays are not allowed' } };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set) {
        return { ok: false, issue: { kind: 'invalid_json', path: [...path, key], message: 'accessors are not allowed' } };
      }
      if (hasLoneSurrogateV1(key)) {
        return { ok: false, issue: { kind: 'invalid_json', path: [...path, key], message: 'lone surrogate key is not allowed' } };
      }
    }
    active.add(value);
    stack.push({ ...frame, exiting: true });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      stack.push({ value: (value as Record<string, unknown>)[key], path: [...path, Array.isArray(value) ? Number(key) : key], depth: depth + 1 });
    }
  }
  return { ok: true, value: input as JsonValue, canonicalBytes: canonicalBytesV1(input as JsonValue) };
};

const canonicalBytesV1 = (input: JsonValue): Uint8Array => {
  const output: string[] = [];
  type CanonicalTask =
    | { kind: 'value'; value: JsonValue }
    | { kind: 'token'; value: string };
  const stack: CanonicalTask[] = [{ kind: 'value', value: input }];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task) break;
    if (task.kind === 'token') {
      output.push(task.value);
      continue;
    }
    const { value } = task;
    if (value === null) output.push('null');
    else if (typeof value === 'boolean') output.push(value ? 'true' : 'false');
    else if (typeof value === 'number') output.push(serializeJsonNumberV1(value));
    else if (typeof value === 'string') output.push(serializeJsonStringV1(value));
    else if (Array.isArray(value)) {
      stack.push({ kind: 'token', value: ']' });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: value[index] as JsonValue });
        if (index > 0) stack.push({ kind: 'token', value: ',' });
      }
      stack.push({ kind: 'token', value: '[' });
    } else {
      const keys = Object.keys(value).sort(compareUnicodeScalarsV1);
      stack.push({ kind: 'token', value: '}' });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) continue;
        stack.push({ kind: 'value', value: value[key] as JsonValue });
        stack.push({ kind: 'token', value: ':' });
        stack.push({ kind: 'token', value: serializeJsonStringV1(key) });
        if (index > 0) stack.push({ kind: 'token', value: ',' });
      }
      stack.push({ kind: 'token', value: '{' });
    }
  }
  return new TextEncoder().encode(output.join(''));
};

const hasDuplicateObjectKeysV1 = (source: string): boolean => {
  const stack: Array<{ kind: 'object' | 'array'; keys?: Set<string>; expectsKey?: boolean }> = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') end += 2;
        else if (source[end] === '"') break;
        else end += 1;
      }
      const frame = stack.at(-1);
      if (frame?.kind === 'object' && frame.expectsKey) {
        try {
          const key = JSON.parse(source.slice(index, end + 1)) as string;
          if (frame.keys?.has(key)) return true;
          frame.keys?.add(key);
        } catch {
          return false;
        }
      }
      index = end;
    } else if (character === '{') stack.push({ kind: 'object', keys: new Set(), expectsKey: true });
    else if (character === '[') stack.push({ kind: 'array' });
    else if (character === '}' || character === ']') stack.pop();
    else if (character === ':') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectsKey = false;
    } else if (character === ',') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectsKey = true;
    }
  }
  return false;
};

export const runDecodedKernelV1 = validateJsonValueV1;

export const runBytesKernelV1 = (bytes: Uint8Array): KernelResultV1<JsonValue> => {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    return { ok: false, issue: { kind: 'payload_too_large', path: [], message: 'envelope byte limit exceeded', actual: bytes.byteLength, maximum: MAX_ENVELOPE_BYTES } };
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, issue: { kind: 'invalid_json', path: [], message: 'malformed UTF-8' } };
  }
  if (hasDuplicateObjectKeysV1(source)) {
    return { ok: false, issue: { kind: 'invalid_json', path: [], message: 'duplicate object member' } };
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return { ok: false, issue: { kind: 'invalid_json', path: [], message: 'malformed JSON' } };
  }
  return validateJsonValueV1(input);
};

export const applySchemaV1 = <Schema extends z.ZodTypeAny>(schema: Schema, kernel: KernelResultV1<JsonValue>): KernelResultV1<z.output<Schema>> => {
  if (!kernel.ok) return kernel;
  const parsed = schema.safeParse(kernel.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, issue: { kind: 'schema', path: issue?.path ?? [], message: issue?.message ?? 'invalid payload' } };
  }
  return { ok: true, value: parsed.data, canonicalBytes: kernel.canonicalBytes };
};
