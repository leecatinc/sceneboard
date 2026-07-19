import type { CreatedPairing } from '../../../lib/api/board-api';

const CREATED_PAIRING_SESSION_KEY = 'sceneboard.created-pairing.v1';
const PAIRING_CODE_PATTERN = /^(?:SB-)?[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/;

type SessionStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

interface StoredCreatedPairing {
  version: 1;
  expiresAt: string;
  pairing: CreatedPairing;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function parseStoredCreatedPairing(value: unknown, now: number): StoredCreatedPairing | null {
  if (!isObject(value) || !hasExactKeys(value, ['version', 'expiresAt', 'pairing']) || value.version !== 1) return null;
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) return null;
  const pairing = value.pairing;
  if (!isObject(pairing)
    || !hasExactKeys(pairing, ['pairingId', 'code', 'state', 'codeExpiresAt'])
    || typeof pairing.pairingId !== 'string'
    || pairing.pairingId.length < 16
    || pairing.pairingId.length > 128
    || typeof pairing.code !== 'string'
    || !PAIRING_CODE_PATTERN.test(pairing.code)
    || pairing.state !== 'created'
    || typeof pairing.codeExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(pairing.codeExpiresAt))) return null;
  return { version: 1, expiresAt: value.expiresAt, pairing: pairing as unknown as CreatedPairing };
}

export function readCreatedPairingSession(storage: SessionStorage, now = Date.now()): CreatedPairing | null {
  try {
    const serialized = storage.getItem(CREATED_PAIRING_SESSION_KEY);
    if (serialized === null) return null;
    const stored = parseStoredCreatedPairing(JSON.parse(serialized), now);
    if (stored !== null) return stored.pairing;
    storage.removeItem(CREATED_PAIRING_SESSION_KEY);
  } catch {
    try { storage.removeItem(CREATED_PAIRING_SESSION_KEY); } catch {}
  }
  return null;
}

export function writeCreatedPairingSession(
  storage: SessionStorage,
  pairing: CreatedPairing,
  expiresAt = pairing.codeExpiresAt,
): void {
  try {
    storage.setItem(CREATED_PAIRING_SESSION_KEY, JSON.stringify({ version: 1, expiresAt, pairing }));
  } catch {}
}

export function clearCreatedPairingSession(storage: SessionStorage): void {
  try { storage.removeItem(CREATED_PAIRING_SESSION_KEY); } catch {}
}
