import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ownerPresentationOperationIsCurrentV1,
  type OwnerPresentationAdmissionIdentityV1,
} from '../../lib/board/owner-presentation-operation';

type PresenterSnapshot = Readonly<{ role: 'presenter'; sessionId: string }>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

test('a deferred presenter start is ended instead of activated after admission becomes stale', async () => {
  const cases: readonly OwnerPresentationAdmissionIdentityV1[] = [
    { mounted: false, boardId: 'board-1', revisionId: 'revision-1', allowed: true },
    { mounted: true, boardId: 'board-2', revisionId: 'revision-1', allowed: true },
    { mounted: true, boardId: 'board-1', revisionId: 'revision-2', allowed: true },
    { mounted: true, boardId: 'board-1', revisionId: 'revision-1', allowed: false },
  ];

  for (const current of cases) {
    const start = deferred<PresenterSnapshot>();
    let activated = 0;
    let ended = 0;
    const settlement = start.promise.then((snapshot) => {
      const admitted = ownerPresentationOperationIsCurrentV1({
        operationEpoch: 7,
        currentOperationEpoch: 7,
        expected: { boardId: 'board-1', revisionId: 'revision-1' },
        current,
      });
      if (!admitted) {
        if (snapshot.role === 'presenter') ended += 1;
        return;
      }
      activated += 1;
    });

    start.resolve({ role: 'presenter', sessionId: 'session-1' });
    await settlement;

    assert.equal(activated, 0);
    assert.equal(ended, 1);
  }
});

test('only the exact mounted board revision and epoch remains admissible', () => {
  const current: OwnerPresentationAdmissionIdentityV1 = {
    mounted: true,
    boardId: 'board-1',
    revisionId: 'revision-1',
    allowed: true,
  };
  assert.equal(
    ownerPresentationOperationIsCurrentV1({
      operationEpoch: 7,
      currentOperationEpoch: 7,
      expected: { boardId: 'board-1', revisionId: 'revision-1' },
      current,
    }),
    true,
  );
  assert.equal(
    ownerPresentationOperationIsCurrentV1({
      operationEpoch: 7,
      currentOperationEpoch: 8,
      expected: { boardId: 'board-1', revisionId: 'revision-1' },
      current,
    }),
    false,
  );
});
