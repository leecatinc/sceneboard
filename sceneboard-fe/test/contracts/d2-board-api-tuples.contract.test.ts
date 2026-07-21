import test from 'node:test';
import { assertPublisher } from './certification-publisher.test-helper';

test('D2 publishes the exact seven auth, pairing, and grant browser selectors', () => {
  assertPublisher({
    name: 'd2-board-api-tuples.v1.json',
    owner: 'D2',
    publisherTestPath: 'sceneboard-fe/test/contracts/d2-board-api-tuples.contract.test.ts',
    contractIds: [
      'D2-PAIRING-LIST-ACTIVE',
      'D2-GRANT-LIST',
      'D2-PAIRING-CREATE',
      'D2-PAIRING-DECIDE',
      'D2-PAIRING-CANCEL',
      'D2-GRANT-REVOKE',
      'D2-GRANT-ROTATE',
    ],
    memberNames: [
      'listActivePairings',
      'listGrants',
      'createPairing',
      'decidePairing',
      'cancelPairing',
      'revokeGrant',
      'rotateGrant',
    ],
  });
});
