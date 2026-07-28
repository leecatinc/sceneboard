import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiRoot = new URL('../../sceneboard-fe/lib/api/', import.meta.url);

const readApiSource = (name) => readFile(new URL(name, apiRoot), 'utf8');

test('keeps the public board API client as a thin domain facade', async () => {
  const facade = await readApiSource('board-api.ts');

  assert.ok(facade.split('\n').length <= 300);
  assert.doesNotMatch(facade, /dispatchShared|parseBoardHttpResultV1|MutationRequestParserV1/);
  for (const moduleName of [
    'board-resource-api',
    'board-hitl-api',
    'board-artifact-api',
    'board-connection-api',
  ]) {
    assert.match(facade, new RegExp(`from './${moduleName}'`));
  }
});

test('owns each board API route in exactly one domain client', async () => {
  const domains = {
    resource: await readApiSource('board-resource-api.ts'),
    hitl: await readApiSource('board-hitl-api.ts'),
    artifact: await readApiSource('board-artifact-api.ts'),
    connection: await readApiSource('board-connection-api.ts'),
  };
  const ownership = {
    listBoards: 'resource',
    listHistory: 'resource',
    requestInteraction: 'hitl',
    cancelInteraction: 'hitl',
    getArtifactPackage: 'artifact',
    requestArtifactNetworkFetch: 'artifact',
    createPairing: 'connection',
    rotateGrant: 'connection',
  };

  for (const [method, owner] of Object.entries(ownership)) {
    for (const [domain, source] of Object.entries(domains)) {
      const declaration = new RegExp(`async ${method}\\(`);
      assert.equal(
        declaration.test(source),
        domain === owner,
        `${method} must be owned only by ${owner}`,
      );
    }
  }
});
