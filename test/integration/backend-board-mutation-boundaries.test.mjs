import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const revisionRoot = new URL('../../sceneboard-be/src/revisions/', import.meta.url);
const readRevisionSource = (name) => readFile(new URL(name, revisionRoot), 'utf8');

test('keeps board mutation service focused on transaction orchestration', async () => {
  const service = await readRevisionSource('board-mutation.service.ts');

  assert.ok(service.split('\n').length <= 560);
  assert.doesNotMatch(
    service,
    /private async (?:prepareRestore|revalidateRestore|replayOrReject)\(/,
  );
  for (const moduleName of [
    'board-mutation.preparer',
    'board-mutation.restore.repository',
    'board-mutation.replay.repository',
  ]) {
    assert.match(service, new RegExp(`from './${moduleName}\\.js'`));
  }
});

test('owns preparation, restore, and replay behavior in separate modules', async () => {
  const modules = {
    preparer: await readRevisionSource('board-mutation.preparer.ts'),
    restore: await readRevisionSource('board-mutation.restore.repository.ts'),
    replay: await readRevisionSource('board-mutation.replay.repository.ts'),
  };
  const ownership = {
    prepare: 'preparer',
    regenerate: 'preparer',
    prepareRestore: 'restore',
    revalidateRestore: 'restore',
    insertReferences: 'restore',
    replayOrReject: 'replay',
  };

  for (const [method, owner] of Object.entries(ownership)) {
    for (const [moduleName, source] of Object.entries(modules)) {
      assert.equal(
        new RegExp(`(?:async )?${method}\\(`).test(source),
        moduleName === owner,
        `${method} must be owned only by ${owner}`,
      );
    }
  }
});
