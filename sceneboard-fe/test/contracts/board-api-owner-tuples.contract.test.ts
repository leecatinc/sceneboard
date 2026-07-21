import assert from 'node:assert/strict';
import test from 'node:test';
import { readPublisher } from './certification-publisher.test-helper';

const owners = ['d2', 'd5', 'd7', 'd8'] as const;

test('serialized browser adapter union contains one exact disjoint four-owner set', () => {
  const publishers = owners.map((owner) => readPublisher(`${owner}-board-api-tuples.v1.json`));
  const names = publishers.flatMap(({ selectors }) =>
    selectors.map(({ memberName }) => memberName),
  );
  const contractIds = publishers.flatMap((publisher) => publisher.contractIds);
  assert.equal(names.length, 22);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(contractIds).size, contractIds.length);
  assert.equal(
    new Set(publishers.map(({ tupleListSha256 }) => tupleListSha256)).size,
    publishers.length,
  );
  assert.deepEqual(names, [
    'listActivePairings',
    'listGrants',
    'createPairing',
    'decidePairing',
    'cancelPairing',
    'revokeGrant',
    'rotateGrant',
    'listBoards',
    'createBoard',
    'getBoard',
    'archiveBoard',
    'renameBoard',
    'listHistory',
    'getHistoryRevision',
    'getArtifact',
    'getArtifactPackage',
    'requestArtifactNetworkFetch',
    'requestInteraction',
    'respondToInteraction',
    'readInteraction',
    'cancelInteraction',
    'supersedeInteraction',
  ]);
});
