import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) =>
  readFile(new URL(`../../src/pairing/${path}`, import.meta.url), 'utf8');

test('pairing persistence contracts are independent from the SQL execution context', async () => {
  const [context, contracts] = await Promise.all([
    readSource('pairing-persistence.context.ts'),
    readSource('pairing-persistence.types.ts'),
  ]);

  assert.doesNotMatch(context, /export interface CreatePairingPersistenceInput/u);
  assert.match(context, /from '\.\/pairing-persistence\.types\.js'/u);
  assert.match(contracts, /export interface CreatePairingPersistenceInput/u);
  assert.ok(context.split('\n').length < 800);
});
