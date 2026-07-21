import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertPublisher } from './certification-publisher.test-helper';

const root = new URL('../../', import.meta.url);

test('D7 publishes exactly the metadata, package, and default-denied broker selectors', () => {
  assertPublisher({
    name: 'd7-board-api-tuples.v1.json',
    owner: 'D7',
    publisherTestPath: 'sceneboard-fe/test/contracts/d7-board-api-tuples.contract.test.ts',
    contractIds: [
      'D7-ARTIFACT-METADATA-GET',
      'D7-ARTIFACT-PACKAGE-GET',
      'D7-ARTIFACT-NETWORK-FETCH',
    ],
    memberNames: ['getArtifact', 'getArtifactPackage', 'requestArtifactNetworkFetch'],
  });
  const source = readFileSync(new URL('lib/api/board-artifact-api.ts', root), 'utf8');
  const coordinator = readFileSync(new URL('lib/auth/renewal-singleflight.ts', root), 'utf8');
  assert.match(coordinator, /responseKind\?: 'json' \| 'artifact-package' \| 'artifact-network'/u);
  assert.match(source, /application\/vnd\.leecat\.artifact-package\.v1/u);
  assert.match(source, /application\/vnd\.leecat\.artifact-network-result\.v1/u);
});
