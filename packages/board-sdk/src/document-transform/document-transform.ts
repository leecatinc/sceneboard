import {
  BOARD_LIMITS_V1,
  BoardDocumentParserV2,
  collectDocumentNodesV2,
  type BoardDocumentV2,
  type BoardError,
  type ImageNodeV1,
  type NodeId,
  type BoardPageV2,
  type BoardParseResult,
  type PageDisplayModeV1,
  type PageId,
  type SceneV1,
} from '@sceneboard/board-schema';

export type DocumentTransformOperationV2 =
  | { type: 'document.replace'; document: BoardDocumentV2 }
  | { type: 'page.add'; page: BoardPageV2; index: number }
  | { type: 'page.remove'; pageId: PageId }
  | { type: 'page.reorder'; pageId: PageId; toIndex: number }
  | {
      type: 'page.update';
      pageId: PageId;
      title?: string;
      displayMode?: PageDisplayModeV1;
      scene?: SceneV1;
    }
  | { type: 'page.default.set'; pageId: PageId };

export type MediaImagePlacementV1 =
  | { kind: 'page-end'; wrapperNodeId: NodeId }
  | {
      kind: 'canvas';
      x: number;
      y: number;
      width: number;
      height: number;
      zIndex: number;
    };

export type PlaceMediaImageOnPageInputV1 = Readonly<{
  document: BoardDocumentV2;
  pageId: PageId;
  image: ImageNodeV1;
  placement: MediaImagePlacementV1;
}>;

const invalidDocument = (
  path: Array<string | number>,
  reason: 'page_count' | 'default_page_missing' | 'unresolved_reference' | 'limit',
): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_DOCUMENT',
  message: 'Invalid document',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { path, reason },
});

const failed = (error: BoardError): BoardParseResult<BoardDocumentV2> => ({ ok: false, error });

const exactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const safeIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const pageIndex = (document: BoardDocumentV2, pageId: PageId): number =>
  document.pages.findIndex((page) => page.pageId === pageId);

const finiteCanvasPlacement = (
  placement: Extract<MediaImagePlacementV1, { kind: 'canvas' }>,
): boolean =>
  Number.isFinite(placement.x) &&
  Number.isFinite(placement.y) &&
  Number.isFinite(placement.width) &&
  Number.isFinite(placement.height) &&
  placement.x >= 0 &&
  placement.y >= 0 &&
  placement.width > 0 &&
  placement.height > 0 &&
  Number.isSafeInteger(placement.zIndex);

export const placeMediaImageOnPageV1 = (
  input: PlaceMediaImageOnPageInputV1,
): BoardParseResult<BoardDocumentV2> => {
  const source = BoardDocumentParserV2.parse(input.document);
  if (!source.ok) return source;
  const current = source.data.value;
  const index = pageIndex(current, input.pageId);
  if (index < 0) return failed(invalidDocument(['pageId'], 'unresolved_reference'));
  if (input.image.type !== 'content.image' || input.image.source.type !== 'media')
    return failed(invalidDocument(['image'], 'limit'));

  const ids = new Set(collectDocumentNodesV2(current).map(({ node }) => node.id));
  if (ids.has(input.image.id)) return failed(invalidDocument(['image', 'id'], 'limit'));
  if (
    input.placement.kind === 'page-end' &&
    (input.placement.wrapperNodeId === input.image.id || ids.has(input.placement.wrapperNodeId))
  )
    return failed(invalidDocument(['placement', 'wrapperNodeId'], 'limit'));

  const page = current.pages[index];
  if (page === undefined) return failed(invalidDocument(['pageId'], 'unresolved_reference'));
  const root = page.scene.root;
  let nextRoot: SceneV1['root'];

  if (root?.type === 'layout.canvas') {
    if (input.placement.kind !== 'canvas' || !finiteCanvasPlacement(input.placement))
      return failed(invalidDocument(['placement'], 'limit'));
    if (root.children.length >= BOARD_LIMITS_V1.maxCanvasItems)
      return failed(invalidDocument(['placement'], 'limit'));
    if (
      input.placement.x + input.placement.width > root.width ||
      input.placement.y + input.placement.height > root.height
    )
      return failed(invalidDocument(['placement'], 'limit'));
    nextRoot = {
      ...root,
      children: [
        ...root.children,
        {
          node: input.image,
          x: input.placement.x,
          y: input.placement.y,
          width: input.placement.width,
          height: input.placement.height,
          zIndex: input.placement.zIndex,
        },
      ],
    };
  } else {
    if (input.placement.kind !== 'page-end') return failed(invalidDocument(['placement'], 'limit'));
    if (root === null) nextRoot = input.image;
    else if (root.type === 'layout.split' && root.direction === 'vertical') {
      if (root.children.length >= BOARD_LIMITS_V1.maxSplitChildren)
        return failed(invalidDocument(['placement'], 'limit'));
      nextRoot = {
        ...root,
        children: [...root.children, { node: input.image, weight: 1 }],
      };
    } else {
      nextRoot = {
        id: input.placement.wrapperNodeId,
        type: 'layout.split',
        direction: 'vertical',
        gap: 16,
        children: [
          { node: root, weight: 1 },
          { node: input.image, weight: 1 },
        ],
      };
    }
  }

  const pages = [...current.pages];
  pages[index] = { ...page, scene: { ...page.scene, root: nextRoot } };
  return BoardDocumentParserV2.parse({ ...current, pages });
};

export const applyDocumentTransformV2 = (
  source: BoardDocumentV2,
  operation: DocumentTransformOperationV2,
): BoardParseResult<BoardDocumentV2> => {
  const document = BoardDocumentParserV2.parse(source);
  if (!document.ok) return document;
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation))
    return failed(invalidDocument(['operation'], 'limit'));

  if (operation.type === 'document.replace') {
    if (!exactKeys(operation, ['type', 'document']))
      return failed(invalidDocument(['operation'], 'limit'));
    return BoardDocumentParserV2.parse(operation.document);
  }

  const current = document.data.value;
  if (operation.type === 'page.add') {
    if (!exactKeys(operation, ['type', 'page', 'index']) || !safeIndex(operation.index))
      return failed(invalidDocument(['operation', 'index'], 'limit'));
    if (operation.index > current.pages.length)
      return failed(invalidDocument(['operation', 'index'], 'page_count'));
    const pages = [...current.pages];
    pages.splice(operation.index, 0, operation.page);
    return BoardDocumentParserV2.parse({ ...current, pages });
  }

  if (operation.type === 'page.remove') {
    if (!exactKeys(operation, ['type', 'pageId']))
      return failed(invalidDocument(['operation'], 'limit'));
    const index = pageIndex(current, operation.pageId);
    if (index < 0) return failed(invalidDocument(['operation', 'pageId'], 'unresolved_reference'));
    if (current.pages.length === 1)
      return failed(invalidDocument(['operation', 'pageId'], 'page_count'));
    if (operation.pageId === current.defaultPageId)
      return failed(invalidDocument(['operation', 'pageId'], 'default_page_missing'));
    return BoardDocumentParserV2.parse({
      ...current,
      pages: current.pages.filter((_, pagePosition) => pagePosition !== index),
    });
  }

  if (operation.type === 'page.reorder') {
    if (
      !exactKeys(operation, ['type', 'pageId', 'toIndex']) ||
      !safeIndex(operation.toIndex) ||
      operation.toIndex >= current.pages.length
    )
      return failed(invalidDocument(['operation', 'toIndex'], 'page_count'));
    const index = pageIndex(current, operation.pageId);
    if (index < 0) return failed(invalidDocument(['operation', 'pageId'], 'unresolved_reference'));
    if (index === operation.toIndex) return document;
    const pages = [...current.pages];
    const [selected] = pages.splice(index, 1);
    if (selected === undefined) return failed(invalidDocument(['operation', 'pageId'], 'limit'));
    pages.splice(operation.toIndex, 0, selected);
    return BoardDocumentParserV2.parse({ ...current, pages });
  }

  if (operation.type === 'page.update') {
    const allowed = new Set(['type', 'pageId', 'title', 'displayMode', 'scene']);
    const keys = Object.keys(operation);
    if (
      keys.some((key) => !allowed.has(key)) ||
      !Object.hasOwn(operation, 'pageId') ||
      !Object.hasOwn(operation, 'type') ||
      !['title', 'displayMode', 'scene'].some((key) => Object.hasOwn(operation, key))
    )
      return failed(invalidDocument(['operation'], 'limit'));
    const index = pageIndex(current, operation.pageId);
    if (index < 0) return failed(invalidDocument(['operation', 'pageId'], 'unresolved_reference'));
    const existing = current.pages[index];
    if (existing === undefined)
      return failed(invalidDocument(['operation', 'pageId'], 'unresolved_reference'));
    const updated = {
      ...existing,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.displayMode === undefined ? {} : { displayMode: operation.displayMode }),
      ...(operation.scene === undefined ? {} : { scene: operation.scene }),
    };
    const pages = [...current.pages];
    pages[index] = updated;
    return BoardDocumentParserV2.parse({ ...current, pages });
  }

  if (operation.type === 'page.default.set') {
    if (!exactKeys(operation, ['type', 'pageId']))
      return failed(invalidDocument(['operation'], 'limit'));
    if (pageIndex(current, operation.pageId) < 0)
      return failed(invalidDocument(['operation', 'pageId'], 'unresolved_reference'));
    return BoardDocumentParserV2.parse({ ...current, defaultPageId: operation.pageId });
  }

  return failed(invalidDocument(['operation', 'type'], 'limit'));
};
