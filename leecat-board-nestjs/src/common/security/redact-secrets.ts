const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|csrf|password|passwd|proof|secret|sessiontoken|accesstoken|refreshtoken|tokenhash|token|verifier|pairingcode|rawcode|otp|code|challenge|hash)/i;
const MAX_REDACTION_DEPTH = 32;
const MAX_REDACTION_ENTRIES = 2_000;

interface RedactionState {
  seen: WeakSet<object>;
  entries: number;
}

const redact = (value: unknown, state: RedactionState, depth: number): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'undefined') return '[UNDEFINED]';
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'symbol' || typeof value === 'function') return '[UNSUPPORTED]';
  if (depth > MAX_REDACTION_DEPTH) return '[DEPTH_LIMIT]';
  if (typeof value !== 'object') return '[UNSUPPORTED]';
  if (state.seen.has(value)) return '[CIRCULAR]';
  state.seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      state.entries += 1;
      if (state.entries > MAX_REDACTION_ENTRIES) {
        output.push('[ENTRY_LIMIT]');
        break;
      }
      output.push(redact(item, state, depth + 1));
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    state.entries += 1;
    if (state.entries > MAX_REDACTION_ENTRIES) {
      output.truncated = '[ENTRY_LIMIT]';
      break;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      output[key] = '[REDACTED_ACCESSOR]';
      continue;
    }
    output[key] = redact(descriptor.value, state, depth + 1);
  }
  return output;
};

export const redactSecrets = (value: unknown): unknown => redact(value, { seen: new WeakSet(), entries: 0 }, 0);
