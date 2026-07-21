import test from 'node:test';
import { assertPublisher } from './certification-publisher.test-helper';

test('D8 publishes exactly five interaction browser selectors', () => {
  assertPublisher({
    name: 'd8-board-api-tuples.v1.json',
    owner: 'D8',
    publisherTestPath: 'sceneboard-fe/test/contracts/d8-board-api-tuples.contract.test.ts',
    contractIds: [
      'D8-HITL-MUTATION-REQUEST',
      'D8-HITL-MUTATION-RESPOND',
      'D8-HITL-READ-WAIT',
      'D8-HITL-LIFECYCLE-CANCEL',
      'D8-HITL-LIFECYCLE-SUPERSEDE',
    ],
    memberNames: [
      'requestInteraction',
      'respondToInteraction',
      'readInteraction',
      'cancelInteraction',
      'supersedeInteraction',
    ],
  });
});
