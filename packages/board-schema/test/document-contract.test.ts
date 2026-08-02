import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  BOARD_DOCUMENT_LIMITS_V2,
  BOARD_DOCUMENT_LIMITS_V3,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_MUTATION_COMMAND_TYPES_V2,
  BoardCapabilitiesParserV2,
  BoardCapabilitiesParserV3,
  BoardDocumentParserV2,
  BoardErrorParser,
  BoardEventEnvelopeParserV2,
  BoardOperationResultParserV2,
  BoardSnapshotParser,
  BoardSnapshotParserV2,
  DEFAULT_BOARD_CAPABILITIES_V1,
  DEFAULT_BOARD_CAPABILITIES_V2,
  DEFAULT_BOARD_CAPABILITIES_V3,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  MutationRequestParserV2,
  MutationResultParserV2,
  adaptLegacySceneToDocumentV2,
  collectArtifactReferencesAcrossSnapshotV2,
  deriveLegacyPageIdV2,
  type BoardDocumentV2,
  type BoardSnapshotV2,
  type SceneV1,
} from '../src/index.js';

const LEGACY_BOARD_CAPABILITIES_V2 = {
  ...DEFAULT_BOARD_CAPABILITIES_V2,
  limits: {
    maxEnvelopeBytes: 1_048_576,
    maxSceneBytes: 786_432,
    maxSceneDepth: 12,
    maxSceneNodes: 500,
    maxJsonDepth: 64,
    maxJsonContainerEntries: 10_000,
    maxSplitChildren: 12,
    maxGridColumns: 24,
    maxGridRows: 100,
    maxGridItems: 200,
    maxTabs: 20,
    maxCanvasItems: 200,
    maxCanvasExtent: 100_000,
    maxTitleChars: 200,
    maxImageAltChars: 500,
    maxMarkdownChars: 100_000,
    maxCodeChars: 200_000,
    maxTableColumns: 50,
    maxTableRows: 500,
    maxTableCells: 10_000,
    maxChartSeries: 32,
    maxChartPoints: 10_000,
    maxMapFeatures: 5_000,
    maxDrawingElements: 5_000,
    maxArtifactResources: 128,
    maxArtifactResourceBytes: 5_242_880,
    maxArtifactTotalBytes: 10_485_760,
    maxBoardArtifacts: 100,
    maxBoardArtifactVersions: 1_000,
    maxBoardArtifactResourceRows: 10_000,
    maxBoardArtifactChargedBytes: 536_870_912,
    maxHitlOptions: 50,
    maxHitlFields: 50,
    maxHitlTextChars: 60_000,
    maxHitlResponseBytes: 65_536,
    maxPageSize: 100,
    maxPageCursorChars: 512,
    maxHitlWaitMs: 30_000,
    maxDocumentPages: 100,
    maxDocumentBytes: 20_971_520,
    maxDocumentPageBytes: 1_048_576,
    maxDocumentNodes: 5_000,
    maxDocumentEnvelopeBytes: 33_554_432,
    maxMediaBytes: 10_485_760,
    maxMediaPixels: 40_000_000,
    maxBoardMediaBytes: 536_870_912,
    maxMediaReferences: 5_000,
  },
} as const;

const emptyScene: SceneV1 = { protocolVersion: 1, type: 'scene', root: null };
const page = (pageId: string, scene: SceneV1 = emptyScene) => ({
  pageId,
  title: '',
  displayMode: 'fit-page' as const,
  scene,
});
const document = (pages = [page('page_a')], defaultPageId = 'page_a') => ({
  schemaVersion: 2 as const,
  defaultPageId,
  pages,
});
const sceneWithNodes = (prefix: string, count: number): SceneV1 =>
  ({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: `${prefix}_root`,
      type: 'layout.canvas',
      width: 10,
      height: 10,
      children: Array.from({ length: count - 1 }, (_, index) => ({
        node: {
          id: `${prefix}_${index}`,
          type: 'content.markdown',
          markdown: '',
        },
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        zIndex: index,
      })),
    },
  }) as unknown as SceneV1;

const documentWithArtifactReferences = (groups: readonly { code: 'A' | 'I'; count: number }[]) => {
  let pageIndex = 0;
  const pages = groups.flatMap((group) => {
    let remaining = group.count;
    const output = [];
    while (remaining > 0) {
      const count = Math.min(remaining, 200);
      const currentPageIndex = pageIndex;
      pageIndex += 1;
      output.push(
        page(`reference_page_${currentPageIndex}`, {
          protocolVersion: 1,
          type: 'scene',
          root: {
            id: `reference_root_${currentPageIndex}`,
            type: 'layout.canvas',
            width: 1_000,
            height: 10,
            children: Array.from({ length: count }, (_, nodeIndex) => ({
              node:
                group.code === 'A'
                  ? {
                      id: `reference_a_${currentPageIndex}_${nodeIndex}`,
                      type: 'content.artifact',
                      artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                      fallbackText: 'fallback',
                    }
                  : {
                      id: `reference_i_${currentPageIndex}_${nodeIndex}`,
                      type: 'content.image',
                      source: {
                        type: 'artifact.resource',
                        artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                        path: 'image.png',
                        sha256: 'a'.repeat(64),
                      },
                      alt: 'image',
                      fit: 'contain',
                    },
              x: nodeIndex,
              y: 0,
              width: 1,
              height: 1,
              zIndex: nodeIndex,
            })),
          },
        } as SceneV1),
      );
      remaining -= count;
    }
    return output;
  });
  return document(pages, pages[0]?.pageId ?? 'reference_page_0');
};

const revision = {
  revisionId: 'revision_2',
  revisionNumber: 2,
  createdAt: '2026-07-28T00:00:00.000Z',
  previousRevisionId: 'revision_1',
  originType: 'document.replace' as const,
  sourceRevisionId: null,
  actor: { principalKind: 'user' as const, principalId: 'user_1' },
};

const snapshot = (value: BoardDocumentV2): BoardSnapshotV2 => ({
  protocolVersion: 1,
  type: 'board.snapshot',
  boardId: 'board_1' as BoardSnapshotV2['boardId'],
  revision: revision as BoardSnapshotV2['revision'],
  document: value,
  hitl: [],
  artifacts: [],
  capabilities: {
    ...DEFAULT_BOARD_CAPABILITIES_V2,
    supported: {
      nodeTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.nodeTypes],
      commandTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.commandTypes],
      operationTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.operationTypes],
      eventTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.eventTypes],
      hitlKinds: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.hitlKinds],
      artifactRequestCapabilities: [
        ...DEFAULT_BOARD_CAPABILITIES_V2.supported.artifactRequestCapabilities,
      ],
    },
    limits: { ...DEFAULT_BOARD_CAPABILITIES_V2.limits },
    grantedCapabilities: ['board.read'],
    allowedArtifactRequestCapabilities: [],
  } as BoardSnapshotV2['capabilities'],
  lastEventSequence: 1,
});

test('accepts strict ordered documents and rejects page identity/default/display violations', () => {
  const atLimit = document(
    Array.from({ length: 100 }, (_, index) => page(`page_${index}`)),
    'page_0',
  );
  assert.equal(BoardDocumentParserV2.parse(atLimit).ok, true);

  const overLimit = BoardDocumentParserV2.parse({
    ...atLimit,
    pages: [...atLimit.pages, page('page_100')],
  });
  assert.equal(overLimit.ok, false);
  if (!overLimit.ok)
    assert.deepEqual(overLimit.error.details, { path: ['pages'], reason: 'page_count' });

  const duplicate = BoardDocumentParserV2.parse(document([page('page_a'), page('page_a')]));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok)
    assert.deepEqual(duplicate.error.details, {
      path: ['pages', 1, 'pageId'],
      reason: 'duplicate_page_id',
    });

  const missing = BoardDocumentParserV2.parse(document([page('page_a')], 'page_missing'));
  assert.equal(missing.ok, false);
  if (!missing.ok)
    assert.deepEqual(missing.error.details, {
      path: ['defaultPageId'],
      reason: 'default_page_missing',
    });

  const display = BoardDocumentParserV2.parse({
    ...document(),
    pages: [{ ...page('page_a'), displayMode: 'stretch' }],
  });
  assert.equal(display.ok, false);
  if (!display.ok)
    assert.deepEqual(display.error.details, {
      path: ['pages', 0, 'displayMode'],
      reason: 'invalid_display_mode',
    });

  const unknownField = BoardDocumentParserV2.parse({ ...document(), extra: true });
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.equal(unknownField.error.code, 'INVALID_DOCUMENT');

  const nodesAtLimit = document(
    Array.from({ length: 25 }, (_, index) =>
      page(`node_page_${index}`, sceneWithNodes(`node_${index}`, 200)),
    ),
    'node_page_0',
  );
  assert.equal(BoardDocumentParserV2.parse(nodesAtLimit).ok, true);
  const nodesOverLimit = BoardDocumentParserV2.parse({
    ...nodesAtLimit,
    pages: [...nodesAtLimit.pages, page('node_page_25', sceneWithNodes('node_25', 200))],
  });
  assert.equal(nodesOverLimit.ok, false);
  if (!nodesOverLimit.ok)
    assert.deepEqual(nodesOverLimit.error.details, { path: ['pages'], reason: 'limit' });
});

test('enforces the public per-artifact A and I occurrence limit across V2 pages', () => {
  assert.equal(MAX_ARTIFACT_REFERENCE_OCCURRENCES, 500);

  for (const code of ['A', 'I'] as const) {
    assert.equal(
      BoardDocumentParserV2.parse(
        documentWithArtifactReferences([{ code, count: MAX_ARTIFACT_REFERENCE_OCCURRENCES }]),
      ).ok,
      true,
    );
    const over = BoardDocumentParserV2.parse(
      documentWithArtifactReferences([{ code, count: MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1 }]),
    );
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.equal(over.error.code, 'INVALID_DOCUMENT');
      assert.equal(over.error.httpStatusHint, 422);
      assert.equal(over.error.details.reason, 'limit');
    }
  }

  assert.equal(
    BoardDocumentParserV2.parse(
      documentWithArtifactReferences([
        { code: 'A', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
        { code: 'I', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
      ]),
    ).ok,
    true,
  );
  const mixedOver = BoardDocumentParserV2.parse(
    documentWithArtifactReferences([
      { code: 'A', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES },
      { code: 'I', count: MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1 },
    ]),
  );
  assert.equal(mixedOver.ok, false);
  if (!mixedOver.ok) {
    assert.equal(mixedOver.error.code, 'INVALID_DOCUMENT');
    assert.equal(mixedOver.error.httpStatusHint, 422);
  }
});

test('freezes legacy V2 capability limits while V3 advertises artifact occurrence capacity', () => {
  assert.equal(BoardCapabilitiesParserV2.parse(LEGACY_BOARD_CAPABILITIES_V2).ok, true);
  assert.deepEqual(DEFAULT_BOARD_CAPABILITIES_V2.limits, LEGACY_BOARD_CAPABILITIES_V2.limits);
  assert.equal('maxArtifactReferenceOccurrences' in DEFAULT_BOARD_CAPABILITIES_V2.limits, false);
  assert.equal(BoardCapabilitiesParserV3.parse(DEFAULT_BOARD_CAPABILITIES_V3).ok, true);
  assert.deepEqual(DEFAULT_BOARD_CAPABILITIES_V3.limits, BOARD_DOCUMENT_LIMITS_V3);
  assert.equal(
    DEFAULT_BOARD_CAPABILITIES_V3.limits.maxArtifactReferenceOccurrences,
    MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  );
});

test('keeps versions, catalogs, limits, and byte profiles exact', () => {
  assert.deepEqual(BOARD_MUTATION_COMMAND_TYPES_V2, [
    ...BOARD_MUTATION_COMMAND_TYPES_V1,
    'document.replace',
  ]);
  assert.equal(DEFAULT_BOARD_CAPABILITIES_V1.schemaVersion, '1.0.0');
  assert.deepEqual(DEFAULT_BOARD_CAPABILITIES_V1.limits, BOARD_LIMITS_V1);
  assert.equal(DEFAULT_BOARD_CAPABILITIES_V2.schemaVersion, '1.1.0');
  assert.deepEqual(DEFAULT_BOARD_CAPABILITIES_V2.limits, BOARD_DOCUMENT_LIMITS_V2);
  assert.equal(BoardCapabilitiesParserV2.parse(DEFAULT_BOARD_CAPABILITIES_V2).ok, true);
  assert.deepEqual(
    {
      maxDocumentPages: DEFAULT_BOARD_CAPABILITIES_V2.limits.maxDocumentPages,
      maxDocumentBytes: DEFAULT_BOARD_CAPABILITIES_V2.limits.maxDocumentBytes,
      maxDocumentPageBytes: DEFAULT_BOARD_CAPABILITIES_V2.limits.maxDocumentPageBytes,
      maxDocumentNodes: DEFAULT_BOARD_CAPABILITIES_V2.limits.maxDocumentNodes,
      maxDocumentEnvelopeBytes: DEFAULT_BOARD_CAPABILITIES_V2.limits.maxDocumentEnvelopeBytes,
    },
    {
      maxDocumentPages: 100,
      maxDocumentBytes: 20_971_520,
      maxDocumentPageBytes: 1_048_576,
      maxDocumentNodes: 5_000,
      maxDocumentEnvelopeBytes: 33_554_432,
    },
  );

  const unknownVersion = BoardDocumentParserV2.parse({ ...document(), schemaVersion: 3 });
  assert.equal(unknownVersion.ok, false);
  if (!unknownVersion.ok)
    assert.deepEqual(unknownVersion.error.details, {
      reason: 'schema_revision',
      supportedMajor: 1,
      receivedMajor: 1,
      field: 'document.schemaVersion',
    });

  const pageAtBase = { ...page('page_a'), padding: '' };
  const pageAt = {
    ...pageAtBase,
    padding: 'x'.repeat(
      BOARD_DOCUMENT_LIMITS_V2.maxDocumentPageBytes -
        new TextEncoder().encode(JSON.stringify(pageAtBase)).byteLength,
    ),
  };
  const pageAtResult = BoardDocumentParserV2.parse(document([pageAt as never]));
  assert.equal(pageAtResult.ok, false);
  if (!pageAtResult.ok) assert.equal(pageAtResult.error.code, 'INVALID_DOCUMENT');
  const pageOver = BoardDocumentParserV2.parse(
    document([{ ...pageAt, padding: `${pageAt.padding}x` } as never]),
  );
  assert.equal(pageOver.ok, false);
  if (!pageOver.ok)
    assert.deepEqual(pageOver.error.details, {
      scope: 'document.page',
      actualBytes: 1_048_577,
      maximumBytes: 1_048_576,
    });

  const documentAtBase = { ...document(), padding: '' };
  const documentAt = {
    ...documentAtBase,
    padding: 'x'.repeat(
      BOARD_DOCUMENT_LIMITS_V2.maxDocumentBytes -
        new TextEncoder().encode(JSON.stringify(documentAtBase)).byteLength,
    ),
  };
  const documentAtResult = BoardDocumentParserV2.parse(documentAt);
  assert.equal(documentAtResult.ok, false);
  if (!documentAtResult.ok) assert.equal(documentAtResult.error.code, 'INVALID_DOCUMENT');
  const documentOver = BoardDocumentParserV2.parse({
    ...documentAt,
    padding: `${documentAt.padding}x`,
  });
  assert.equal(documentOver.ok, false);
  if (!documentOver.ok)
    assert.deepEqual(documentOver.error.details, {
      scope: 'document',
      actualBytes: 20_971_521,
      maximumBytes: 20_971_520,
    });

  const oversizedEnvelope = BoardDocumentParserV2.parseBytes(
    new Uint8Array(BOARD_DOCUMENT_LIMITS_V2.maxDocumentEnvelopeBytes + 1),
  );
  assert.equal(oversizedEnvelope.ok, false);
  if (!oversizedEnvelope.ok)
    assert.deepEqual(oversizedEnvelope.error.details, {
      scope: 'document.envelope',
      actualBytes: 33_554_433,
      maximumBytes: 33_554_432,
    });

  assert.equal(
    BoardErrorParser.parse({
      protocolVersion: 1,
      type: 'board.error',
      code: 'DOCUMENT_VERSION_MISMATCH',
      message: 'Document version mismatch',
      category: 'conflict',
      retryable: false,
      httpStatusHint: 409,
      details: {
        headSchemaVersion: 2,
        commandSchemaVersion: 1,
        commandType: 'scene.replace',
      },
    }).ok,
    true,
  );
  assert.equal(
    BoardErrorParser.parse({
      protocolVersion: 1,
      type: 'board.error',
      code: 'INVALID_DOCUMENT',
      message: 'Invalid document',
      category: 'validation',
      retryable: false,
      httpStatusHint: 422,
      details: { path: ['pages'], reason: 'page_count' },
    }).ok,
    true,
  );
});

test('adapts legacy scenes deterministically without copying or revision coupling', () => {
  const boardId = 'board_1' as BoardSnapshotV2['boardId'];
  const expected = `legacy-${createHash('sha256')
    .update(`sceneboard:legacy-page:${boardId}`)
    .digest('base64url')
    .slice(0, 22)}`;
  assert.equal(deriveLegacyPageIdV2(boardId), expected);
  const first = adaptLegacySceneToDocumentV2({ boardId, scene: emptyScene });
  const second = adaptLegacySceneToDocumentV2({ boardId, scene: emptyScene });
  assert.equal(first.pages[0]?.pageId, second.pages[0]?.pageId);
  assert.equal(first.pages[0]?.scene, emptyScene);
  assert.deepEqual(first, {
    schemaVersion: 2,
    defaultPageId: expected,
    pages: [{ pageId: expected, title: '', displayMode: 'fit-page', scene: emptyScene }],
  });
});

test('selects exactly one snapshot branch and validates all pages against shared inventories', () => {
  const parsedDocument = BoardDocumentParserV2.parse(document());
  assert.equal(parsedDocument.ok, true);
  if (!parsedDocument.ok) return;
  const validSnapshot = snapshot(parsedDocument.data.value);
  assert.equal(BoardSnapshotParserV2.parse(validSnapshot).ok, true);
  assert.equal(BoardSnapshotParser.parse(validSnapshot).ok, true);
  assert.equal(BoardSnapshotParser.parse({ ...validSnapshot, scene: emptyScene }).ok, false);
  const { document: _removed, ...withoutBranch } = validSnapshot;
  assert.equal(BoardSnapshotParser.parse(withoutBranch).ok, false);

  const duplicateNodeDocument = document([
    page('page_a', {
      protocolVersion: 1,
      type: 'scene',
      root: { id: 'same', type: 'content.markdown', markdown: 'a' },
    } as unknown as SceneV1),
    page('page_b', {
      protocolVersion: 1,
      type: 'scene',
      root: { id: 'same', type: 'content.markdown', markdown: 'b' },
    } as unknown as SceneV1),
  ]);
  const duplicateNode = BoardDocumentParserV2.parse(duplicateNodeDocument);
  assert.equal(duplicateNode.ok, false);
  if (!duplicateNode.ok)
    assert.deepEqual(duplicateNode.error.details, {
      path: ['pages', 1, 'scene', 'root', 'id'],
      reason: 'duplicate_node_id',
    });

  const unresolvedDocument = BoardDocumentParserV2.parse(
    document([
      page('page_a', {
        protocolVersion: 1,
        type: 'scene',
        root: { id: 'hitl', type: 'content.hitl', hitlRequestId: 'hitl_1' },
      } as unknown as SceneV1),
    ]),
  );
  assert.equal(unresolvedDocument.ok, true);
  if (!unresolvedDocument.ok) return;
  const unresolved = BoardSnapshotParserV2.parse(snapshot(unresolvedDocument.data.value));
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok)
    assert.deepEqual(unresolved.error.details, {
      path: ['document', 'pages', 0, 'scene', 'root', 'hitlRequestId'],
      reason: 'unresolved_reference',
    });
});

test('parses exact whole-document commands/results and emits stable artifact handoff order', () => {
  const artifactScene = (id: string, artifactId: string, versionId: string): SceneV1 => ({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: id as never,
      type: 'content.artifact',
      artifact: { artifactId: artifactId as never, versionId: versionId as never },
      fallbackText: 'fallback',
    },
  });
  const parsedDocument = BoardDocumentParserV2.parse(
    document([
      page('page_a', artifactScene('artifact_a', 'artifact_1', 'version_1')),
      page('page_b', artifactScene('artifact_b', 'artifact_1', 'version_1')),
      page('page_c', artifactScene('artifact_c', 'artifact_2', 'version_2')),
    ]),
  );
  assert.equal(parsedDocument.ok, true);
  if (!parsedDocument.ok) return;

  const request = MutationRequestParserV2.parse({
    protocolVersion: 1,
    requestId: 'request_1',
    idempotencyKey: 'document-replace-1',
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    command: { type: 'document.replace', document: parsedDocument.data.value },
  });
  assert.equal(request.ok, true);
  const result = MutationResultParserV2.parse({
    protocolVersion: 1,
    type: 'mutation.result',
    requestId: 'request_1',
    boardId: 'board_1',
    replayed: false,
    eventIds: ['event_1'],
    result: {
      type: 'document.replace',
      revision: {
        revisionId: 'revision_2',
        revisionNumber: 2,
        createdAt: '2026-07-28T00:00:00.000Z',
      },
      originType: 'document.replace',
      sourceRevisionId: null,
      document: parsedDocument.data.value,
    },
  });
  assert.equal(result.ok, true);

  assert.equal(
    BoardOperationResultParserV2.parse({
      protocolVersion: 1,
      type: 'board.operation.result',
      requestId: 'request_2',
      replayed: false,
      result: {
        type: 'history.list',
        entries: [
          {
            revision: {
              revisionId: 'revision_2',
              revisionNumber: 2,
              createdAt: '2026-07-28T00:00:00.000Z',
            },
            previousRevisionId: 'revision_1',
            originType: 'document.replace',
            sourceRevisionId: null,
            actor: { principalKind: 'user', principalId: 'user_1' },
          },
        ],
        nextCursor: null,
      },
    }).ok,
    true,
  );

  assert.equal(
    BoardEventEnvelopeParserV2.parse({
      protocolVersion: 1,
      type: 'board.event',
      boardId: 'board_1',
      eventId: 'event_2',
      sequence: 2,
      occurredAt: '2026-07-28T00:00:00.000Z',
      revisionId: 'revision_2',
      data: {
        type: 'board.revision.created',
        revision: {
          revisionId: 'revision_2',
          revisionNumber: 2,
          createdAt: '2026-07-28T00:00:00.000Z',
        },
        originType: 'document.replace',
        sourceRevisionId: null,
      },
    }).ok,
    true,
  );

  const parsedSnapshot = BoardSnapshotParserV2.parse({
    ...snapshot(parsedDocument.data.value),
    artifacts: [
      {
        artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
        status: 'ready',
        updatedAt: '2026-07-28T00:00:00.000Z',
        failure: null,
      },
      {
        artifact: { artifactId: 'artifact_2', versionId: 'version_2' },
        status: 'ready',
        updatedAt: '2026-07-28T00:00:00.000Z',
        failure: null,
      },
    ],
  });
  assert.equal(parsedSnapshot.ok, true);
  if (!parsedSnapshot.ok) return;
  assert.deepEqual(
    collectArtifactReferencesAcrossSnapshotV2({
      boardId: parsedSnapshot.data.value.boardId,
      revisionId: parsedSnapshot.data.value.revision.revisionId,
      snapshot: parsedSnapshot.data.value,
    }),
    [
      {
        boardId: 'board_1',
        revisionId: 'revision_2',
        firstPageId: 'page_a',
        artifactId: 'artifact_1',
        versionId: 'version_1',
        ordinal: 1,
      },
      {
        boardId: 'board_1',
        revisionId: 'revision_2',
        firstPageId: 'page_c',
        artifactId: 'artifact_2',
        versionId: 'version_2',
        ordinal: 2,
      },
    ],
  );
});

test('orders and deduplicates direct and artifact-backed image packages by first use', () => {
  const direct = (id: string, artifactId: string, versionId: string): SceneV1 => ({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: id as never,
      type: 'content.artifact',
      artifact: { artifactId: artifactId as never, versionId: versionId as never },
      fallbackText: 'fallback',
    },
  });
  const image = (id: string, artifactId: string, versionId: string): SceneV1 => ({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: id as never,
      type: 'content.image',
      source: {
        type: 'artifact.resource',
        artifact: { artifactId: artifactId as never, versionId: versionId as never },
        path: 'image.png',
        sha256: 'a'.repeat(64),
      },
      alt: 'image',
      fit: 'contain',
    },
  });
  const parsedDocument = BoardDocumentParserV2.parse(
    document([
      page('page_a', image('image_a', 'artifact_1', 'version_1')),
      page('page_b', direct('artifact_b', 'artifact_1', 'version_1')),
      page('page_c', image('image_c', 'artifact_2', 'version_2')),
      page('page_d', image('image_d', 'artifact_2', 'version_2')),
    ]),
  );
  assert.equal(parsedDocument.ok, true);
  if (!parsedDocument.ok) return;
  const parsedSnapshot = BoardSnapshotParserV2.parse({
    ...snapshot(parsedDocument.data.value),
    artifacts: [
      {
        artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
        status: 'ready',
        updatedAt: '2026-07-28T00:00:00.000Z',
        failure: null,
      },
      {
        artifact: { artifactId: 'artifact_2', versionId: 'version_2' },
        status: 'ready',
        updatedAt: '2026-07-28T00:00:00.000Z',
        failure: null,
      },
    ],
  });
  assert.equal(parsedSnapshot.ok, true);
  if (!parsedSnapshot.ok) return;
  assert.deepEqual(
    collectArtifactReferencesAcrossSnapshotV2({
      boardId: parsedSnapshot.data.value.boardId,
      revisionId: parsedSnapshot.data.value.revision.revisionId,
      snapshot: parsedSnapshot.data.value,
    }),
    [
      {
        boardId: 'board_1',
        revisionId: 'revision_2',
        firstPageId: 'page_a',
        artifactId: 'artifact_1',
        versionId: 'version_1',
        ordinal: 1,
      },
      {
        boardId: 'board_1',
        revisionId: 'revision_2',
        firstPageId: 'page_c',
        artifactId: 'artifact_2',
        versionId: 'version_2',
        ordinal: 2,
      },
    ],
  );
});
