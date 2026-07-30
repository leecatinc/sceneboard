import assert from 'node:assert/strict';
import test from 'node:test';

import * as root from '../../src/index.js';
import * as http from '../../src/http/index.js';
import * as documentTransform from '../../src/document-transform/index.js';
import * as transform from '../../src/scene-transform/index.js';
import type { BoardSdkHttpClientOptionsV1, BoardSdkHttpResultV1 } from '../../src/http/index.js';
import type {
  ChildPlacementV1,
  SceneTransformOperationV1,
} from '../../src/scene-transform/index.js';

const compileTypes = (
  _options: BoardSdkHttpClientOptionsV1 | null,
  _result: BoardSdkHttpResultV1<'board.get'> | null,
  _placement: ChildPlacementV1 | null,
  _operation: SceneTransformOperationV1 | null,
): void => undefined;

test('D6 HTTP and scene-transform leaf barrels expose only their closed runtimes', () => {
  compileTypes(null, null, null, null);
  assert.deepEqual(Object.keys(http).sort(), [
    'BoardSdkHttpClient',
    'parseBoardDocumentHttpResultV2',
    'parseBoardDocumentHttpResultV3',
    'parseBoardHttpResultV1',
    'parseBoardOperationHttpResultV2',
    'parseBoardOperationHttpResultV3',
  ]);
  assert.deepEqual(Object.keys(documentTransform).sort(), [
    'applyDocumentTransformV2',
    'placeMediaImageOnPageV1',
  ]);
  assert.deepEqual(Object.keys(transform).sort(), ['applySceneTransformV1']);
});

test('D1 root facade remains unchanged by additive D4 and D6 leaves', () => {
  assert.deepEqual(Object.keys(root).sort(), [
    'BOARD_ERROR_CODES_V1',
    'BOARD_EVENT_TYPES_V1',
    'BOARD_MUTATION_COMMAND_TYPES_V1',
    'BOARD_OPERATION_TYPES_V1',
    'BoardCapabilitiesParserV1',
    'BoardErrorParserV1',
    'BoardEventEnvelopeParserV1',
    'BoardOperationRequestParserV1',
    'BoardOperationResultParserV1',
    'BoardSnapshotParserV1',
    'MutationRequestParserV1',
    'MutationResultParserV1',
    'NODE_TYPES_V1',
    'PROTOCOL_SEMVER',
    'PROTOCOL_VERSION',
    'SceneParserV1',
    'canonicalizeJsonV1',
  ]);
});
