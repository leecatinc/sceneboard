import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('account and public media adapters remain disjoint and both production callers wire the port', async () => {
  const [account, publicContract, boardClient, sharedClient, imageBlock] = await Promise.all([
    readFile(new URL('../../lib/api/board-media-api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../lib/api/public-share-contract.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/boards/[boardId]/board-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/s/[shareToken]/shared-board-client.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../../../packages/board-ui/src/renderer/blocks/ImageBlock.tsx', import.meta.url),
      'utf8',
    ),
  ]);
  assert.match(account, /\/api\/v1\/boards\/[\s\S]*\/revisions\/[\s\S]*\/media\//u);
  assert.doesNotMatch(account, /public\/shares|shareToken|contextId|publicationGeneration/u);
  assert.match(publicContract, /resource\.url/u);
  assert.doesNotMatch(publicContract, /\/api\/v1\/boards\/|createAccountMediaResolver/u);
  assert.match(boardClient, /createAccountMediaResolverV1/u);
  assert.match(boardClient, /mediaResolver/u);
  assert.match(sharedClient, /createPublicShareMediaResolverV1/u);
  assert.match(sharedClient, /mediaResolver/u);
  assert.match(sharedClient, /requestEpochRef\.current \+= 1/u);
  assert.match(sharedClient, /setAccepted\(\{ state: \{ state: 'unavailable' \}/u);
  assert.match(imageBlock, /key=\{requestKey\}/u);
  assert.match(imageBlock, /requestKeyRef\.current !== requestKey/u);
  assert.match(imageBlock, /'error' in resolution/u);
});
