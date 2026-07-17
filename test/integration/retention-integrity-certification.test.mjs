import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('history restore remains copy-forward and security retention rejects non-deletable targets', async () => {
  const mutation = await readFile(new URL('leecat-board-nestjs/src/revisions/board-mutation.service.ts', root), 'utf8');
  const retention = await readFile(new URL('leecat-board-nestjs/src/maintenance/security-retention.service.ts', root), 'utf8');
  assert.match(mutation, /operation === 'scene\.restore'/u);
  assert.match(mutation, /INSERT INTO board_revisions/u);
  assert.match(mutation, /sourceRevisionId/u);
  assert.match(retention, /retention target is not deletable/u);
  assert.match(retention, /MAX_ROWS = 10_000/u);
  assert.doesNotMatch(retention, /TRUNCATE|DROP TABLE/iu);
});
