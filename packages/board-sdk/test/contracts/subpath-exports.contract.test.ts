import assert from 'node:assert/strict';
import test from 'node:test';

import * as root from '@leecat-board/board-sdk';
import * as events from '@leecat-board/board-sdk/events';
import * as http from '@leecat-board/board-sdk/http';
import * as sceneTransform from '@leecat-board/board-sdk/scene-transform';
import * as sse from '@leecat-board/board-sdk/sse';

test('the serialized SDK checkpoint resolves all five exact package targets', () => {
  assert.deepEqual(Object.keys(events).sort(), ['createBoardEventReconcilerV1']);
  assert.deepEqual(Object.keys(sse).sort(), ['createBoardStreamClientV1', 'createBoardStreamTabIdV1']);
  assert.deepEqual(Object.keys(http).sort(), ['BoardSdkHttpClient', 'parseBoardHttpResultV1']);
  assert.deepEqual(Object.keys(sceneTransform).sort(), ['applySceneTransformV1']);
  assert.equal(Object.hasOwn(root, 'BoardSdkHttpClient'), false);
  assert.equal(Object.hasOwn(root, 'createBoardStreamClientV1'), false);
  assert.equal(Object.hasOwn(root, 'applySceneTransformV1'), false);
});
