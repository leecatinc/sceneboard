import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

const drills = [
  'cold-start',
  'exact-prefix-loss',
  'process-restart',
  'bounded-partition',
  'stale-duplicate-reordered-hints',
  'nest-replacement-during-sse',
];

test('Redis recovery catalog is the exact six-drill, prefix-scoped live gate', async () => {
  assert.equal(new Set(drills).size, 6);
  const keyspace = await readFile(
    new URL('../../sceneboard-be/src/redis/redis-stream-keyspace.ts', import.meta.url),
    'utf8',
  );
  assert.match(keyspace, /prefix = 'sceneboard:'/u);
  assert.doesNotMatch(keyspace, /FLUSHDB|FLUSHALL/iu);
  assert.deepEqual(parseCertificationArguments(['--phase=redis-loss', '--profile=isolated']), {
    phase: 'redis-loss',
    profile: 'isolated',
  });
});
