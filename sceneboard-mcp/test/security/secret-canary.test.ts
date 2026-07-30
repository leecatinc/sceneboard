import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SafeStderrLoggerV1 } from '../../src/diagnostics/safe-logger.js';

const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;

test('safe diagnostics redact credentials, pairing proof, code, generation, and store paths', () => {
  let output = '';
  const logger = new SafeStderrLoggerV1((line) => {
    output += line;
  });
  logger.log({
    event: `failure ${token} ${apiKey} PairingProof ${'c'.repeat(43)}`,
    requestId: 'abcdefghijklmnopqrstuv',
    route: '/safe/template',
  });
  assert.equal(output.includes(token), false);
  assert.equal(output.includes(apiKey), false);
  assert.equal(output.includes('c'.repeat(43)), false);
});

test('MCP source has no direct database, Redis, Nest application, or deep backend import', async () => {
  const server = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const gateway = await readFile(
    new URL('../../src/tools/protected-board.gateway.ts', import.meta.url),
    'utf8',
  );
  const source = `${server}\n${gateway}`;
  for (const forbidden of [
    'mysql2',
    'ioredis',
    "from 'redis'",
    'sceneboard-be',
    '../sceneboard-be',
  ]) {
    assert.equal(source.includes(forbidden), false);
  }
});
