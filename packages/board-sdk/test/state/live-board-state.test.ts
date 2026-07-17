import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BoardSnapshotParserV1, type BoardSnapshotV1, type RevisionId } from '@leecat-board/board-schema';

import { RequestEpochV1 } from '../../src/client/index.js';
import {
  createLiveBoardStateV1,
  enterHistoryV1,
  hasLiveUpdateV1,
  replaceLiveSnapshotV1,
  visibleBoardSnapshotV1,
} from '../../src/state/index.js';

const parsed = BoardSnapshotParserV1.parse(JSON.parse(readFileSync(new URL('../../../board-schema/test/fixtures/valid/snapshot-board.v1.json', import.meta.url), 'utf8')));
if (!parsed.ok) throw new TypeError('snapshot fixture is invalid');
const first = parsed.data.value;

const revision = (source: BoardSnapshotV1, id: string, number: number): BoardSnapshotV1 => ({
  ...source,
  revision: {
    ...source.revision,
    revisionId: id as RevisionId,
    revisionNumber: number,
    previousRevisionId: source.revision.revisionId,
    originType: 'scene.replace',
  },
});

test('historical view stays immutable while the hidden live head advances', () => {
  const second = revision(first, 'revision_2', 2);
  const third = revision(second, 'revision_3', 3);
  let state = createLiveBoardStateV1(second);
  state = enterHistoryV1(state, first, {
    revisionId: first.revision.revisionId,
    previousRevisionId: null,
    nextRevisionId: second.revision.revisionId,
    latestRevisionId: second.revision.revisionId,
    label: 'Initial',
  });
  const visible = visibleBoardSnapshotV1(state);
  state = replaceLiveSnapshotV1(state, third);
  assert.equal(visibleBoardSnapshotV1(state), visible);
  assert.equal(hasLiveUpdateV1(state), true);
});

test('request epoch rejects late work after navigation and close', () => {
  const epoch = new RequestEpochV1();
  const initial = epoch.capture();
  assert.equal(epoch.isCurrent(initial), true);
  epoch.advance();
  assert.equal(epoch.isCurrent(initial), false);
  const latest = epoch.capture();
  epoch.close();
  assert.equal(epoch.isCurrent(latest), false);
});
