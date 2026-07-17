export type StrictJsonBytesParseV1 =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'utf8' | 'json' | 'duplicate_member' };

const hasDuplicateMembers = (source: string): boolean => {
  type Frame = { kind: 'object'; keys: Set<string>; expectsKey: boolean } | { kind: 'array' };
  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        const frame = stack.at(-1);
        if (frame?.kind === 'object' && frame.expectsKey) {
          let key: unknown;
          try {
            key = JSON.parse(source.slice(stringStart, index + 1));
          } catch {
            return false;
          }
          if (typeof key === 'string') {
            if (frame.keys.has(key)) return true;
            frame.keys.add(key);
          }
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
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

export const parseStrictJsonBytesV1 = (bytes: Uint8Array): StrictJsonBytesParseV1 => {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'utf8' };
  }
  if (hasDuplicateMembers(source)) return { ok: false, reason: 'duplicate_member' };
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false, reason: 'json' };
  }
};
