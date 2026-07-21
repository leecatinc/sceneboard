const SECRET_KEY =
  /(authorization|token|proof|challenge|code|password|cookie|secret|path|generation)/i;
const TOKEN_PATTERN = /lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g;
const PAIRING_PROOF_PATTERN = /PairingProof\s+[A-Za-z0-9_-]+/gi;

export const redactSecretsV1 = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(TOKEN_PATTERN, '[REDACTED]')
      .replace(PAIRING_PROOF_PATTERN, 'PairingProof [REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redactSecretsV1(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecretsV1(item, depth + 1);
    }
    return result;
  }
  return value;
};
