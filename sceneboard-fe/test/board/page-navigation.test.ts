import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardDocumentParserV2,
  BoardSnapshotParserV1,
  BoardSnapshotParserV2,
  DEFAULT_BOARD_CAPABILITIES_V2,
  type BoardDocumentV2,
  type BoardSnapshotV1,
  type BoardSnapshotV2,
  type PageId,
} from '@sceneboard/board-schema';

import {
  admitPageNavigationKeyV1,
  documentForPageNavigationV1,
  navigatePageIdV1,
  resolveSelectedPageIdV1,
  type PageNavigationAdmissionV1,
} from '../../lib/board/page-navigation';
import { adaptSnapshotToPageRenderV2 } from '../../lib/board/page-render-adapter';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/board-schema/test/fixtures/valid/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

const document = (): BoardDocumentV2 => {
  const parsed = BoardDocumentParserV2.parse({
    schemaVersion: 2,
    defaultPageId: 'page_b',
    pages: ['a', 'b', 'c'].map((suffix) => ({
      pageId: `page_${suffix}`,
      title: `Page ${suffix.toUpperCase()}`,
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: {
          id: `node_${suffix}`,
          type: 'content.markdown',
          markdown: `Visible ${suffix.toUpperCase()}`,
        },
      },
    })),
  });
  if (!parsed.ok) throw new TypeError('document fixture is invalid');
  return parsed.data.value;
};

const admission = (
  overrides: Partial<PageNavigationAdmissionV1> = {},
): PageNavigationAdmissionV1 => ({
  key: 'ArrowRight',
  defaultPrevented: false,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  target: null,
  composedPath: [],
  hitlInteractionActive: false,
  artifactCaptureActive: false,
  moveCaptureActive: false,
  ...overrides,
});

test('stable page selection preserves ID then falls back to default and first', () => {
  const current = document();
  assert.equal(resolveSelectedPageIdV1(current, 'page_c' as PageId), 'page_c');
  assert.equal(resolveSelectedPageIdV1(current, 'page_removed' as PageId), 'page_b');
  assert.equal(
    resolveSelectedPageIdV1(
      { ...current, defaultPageId: 'page_removed' as PageId },
      'page_removed' as PageId,
    ),
    'page_a',
  );
  assert.equal(navigatePageIdV1(current, 'page_a' as PageId, 'previous'), 'page_a');
  assert.equal(navigatePageIdV1(current, 'page_a' as PageId, 'next'), 'page_b');
  assert.equal(navigatePageIdV1(current, 'page_b' as PageId, 'last'), 'page_c');
  assert.equal(navigatePageIdV1(current, 'page_c' as PageId, 'first'), 'page_a');
});

test('keyboard admission maps the full grammar and rejects every interactive capture fact', () => {
  assert.equal(admitPageNavigationKeyV1(admission({ key: 'PageUp' })), 'previous');
  assert.equal(admitPageNavigationKeyV1(admission({ key: 'PageDown' })), 'next');
  assert.equal(admitPageNavigationKeyV1(admission({ key: 'Home' })), 'first');
  assert.equal(admitPageNavigationKeyV1(admission({ key: 'End' })), 'last');
  assert.equal(
    admitPageNavigationKeyV1(
      admission({
        target: { tagName: 'INPUT', role: null, isContentEditable: false },
      }),
    ),
    null,
  );
  assert.equal(
    admitPageNavigationKeyV1(
      admission({
        composedPath: [{ tagName: 'DIV', role: 'dialog', isContentEditable: false }],
      }),
    ),
    null,
  );
  for (const field of [
    'defaultPrevented',
    'isComposing',
    'altKey',
    'ctrlKey',
    'metaKey',
    'hitlInteractionActive',
    'artifactCaptureActive',
    'moveCaptureActive',
  ] as const)
    assert.equal(admitPageNavigationKeyV1(admission({ [field]: true })), null, field);
});

test('page render adapter sends only the selected V2 root and exact snapshot-wide context', () => {
  const base = fixture('snapshot-board.v1.json') as BoardSnapshotV1;
  const { scene: _scene, ...snapshotFields } = base;
  void _scene;
  const parsed = BoardSnapshotParserV2.parse({
    ...snapshotFields,
    document: document(),
    capabilities: {
      ...DEFAULT_BOARD_CAPABILITIES_V2,
      grantedCapabilities: [...base.capabilities.grantedCapabilities],
    },
  });
  if (!parsed.ok) throw new TypeError('V2 snapshot fixture is invalid');
  const snapshot = parsed.data.value as BoardSnapshotV2;
  const result = adaptSnapshotToPageRenderV2(snapshot, 'page_c' as PageId);
  assert.equal(result.page.pageId, 'page_c');
  assert.equal(result.page.scene.root?.id, 'node_c');
  assert.deepEqual(result.context.artifacts, snapshot.artifacts);
  assert.deepEqual(result.context.hitl, snapshot.hitl);
  assert.deepEqual(result.context.capabilities, snapshot.capabilities);
  assert.equal(result.context.documentSchemaVersion, 2);
  assert.equal(result.context.selectedPageId, 'page_c');
  assert.throws(
    () => adaptSnapshotToPageRenderV2(snapshot, 'page_removed' as PageId),
    /selected page is not present/u,
  );
});

test('legacy snapshots adapt to one selected page without redundant page state', () => {
  const parsed = BoardSnapshotParserV1.parse(fixture('snapshot-board.v1.json'));
  if (!parsed.ok) throw new TypeError('legacy snapshot fixture is invalid');
  const legacyDocument = documentForPageNavigationV1(parsed.data.value);
  const selected = resolveSelectedPageIdV1(legacyDocument, null);
  const result = adaptSnapshotToPageRenderV2(parsed.data.value, selected);
  assert.equal(legacyDocument.pages.length, 1);
  assert.equal(result.page.pageId, selected);
  assert.equal(result.context.documentSchemaVersion, 1);
});
