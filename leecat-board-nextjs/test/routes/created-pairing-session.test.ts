import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreatedPairing } from '../../lib/api/board-api';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../lib/ai-connections/created-pairing-session';

function memoryStorage() {
  let serialized: string | null = null;
  return {
    storage: {
      getItem: () => serialized,
      setItem: (_key: string, value: string) => { serialized = value; },
      removeItem: () => { serialized = null; },
    },
    seed(value: string) { serialized = value; },
    value() { return serialized; },
  };
}

const pairing: CreatedPairing = {
  pairingId: '0123456789ABCDEFGHJKMN',
  code: 'SB-ABC123-DEF456',
  state: 'created',
  codeExpiresAt: '2026-07-17T13:05:00.000Z',
};

test('restores the matching code only inside its bounded tab session lifetime', () => {
  const memory = memoryStorage();
  writeCreatedPairingSession(memory.storage, pairing, '2026-07-17T13:10:00.000Z');
  assert.deepEqual(readCreatedPairingSession(memory.storage, Date.parse('2026-07-17T13:09:59.000Z')), pairing);
  assert.equal(readCreatedPairingSession(memory.storage, Date.parse('2026-07-17T13:10:00.000Z')), null);
  assert.equal(memory.value(), null);
});

test('restores an already-issued legacy code during its remaining session lifetime', () => {
  const memory = memoryStorage();
  const legacyPairing = { ...pairing, code: 'ABC123-DEF456' };
  writeCreatedPairingSession(memory.storage, legacyPairing, '2026-07-17T13:10:00.000Z');
  assert.deepEqual(readCreatedPairingSession(memory.storage, Date.parse('2026-07-17T13:09:59.000Z')), legacyPairing);
});

test('rejects and removes malformed or explicitly dismissed pairing session data', () => {
  const memory = memoryStorage();
  memory.seed('{"version":1}');
  assert.equal(readCreatedPairingSession(memory.storage), null);
  assert.equal(memory.value(), null);

  writeCreatedPairingSession(memory.storage, pairing);
  clearCreatedPairingSession(memory.storage);
  assert.equal(memory.value(), null);
});

test('fails closed when browser session storage is unavailable', () => {
  const unavailable = {
    getItem: () => { throw new Error('unavailable'); },
    setItem: () => { throw new Error('unavailable'); },
    removeItem: () => { throw new Error('unavailable'); },
  };
  assert.doesNotThrow(() => writeCreatedPairingSession(unavailable, pairing));
  assert.equal(readCreatedPairingSession(unavailable), null);
  assert.doesNotThrow(() => clearCreatedPairingSession(unavailable));
});
