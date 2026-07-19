import test from 'node:test';
import { assertPublisher } from './certification-publisher.test-helper';

test('D5 publishes exactly seven disjoint browser API selectors', () => {
  assertPublisher({
    name: 'd5-board-api-tuples.v1.json',
    owner: 'D5',
    publisherTestPath: 'leecat-board-nextjs/test/contracts/d5-board-api-tuples.contract.test.ts',
    contractIds: ['D5-BOARD-LIST', 'D5-BOARD-CREATE', 'D5-BOARD-GET', 'D5-BOARD-ARCHIVE', 'D5-BOARD-RENAME', 'D5-HISTORY-LIST', 'D5-HISTORY-GET'],
    memberNames: ['listBoards', 'createBoard', 'getBoard', 'archiveBoard', 'renameBoard', 'listHistory', 'getHistoryRevision'],
  });
});
