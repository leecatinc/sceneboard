import {
  adaptLegacySceneToDocumentV2,
  BoardSnapshotParserV1,
  BoardSnapshotParserV2,
  BoardSnapshotParserV3,
  type BoardSnapshot,
  type PageId,
} from '@sceneboard/board-schema';
import type { BoardRendererPropsV2, PageRendererContextV2 } from '@sceneboard/board-ui/renderer';

export type PageRenderInputV2 = Pick<BoardRendererPropsV2, 'page' | 'context'>;

export type NestedCanvasFitV1 = Readonly<{
  scale: number;
  reservedWidth: number;
  reservedHeight: number;
}>;

export type NestedCanvasFitInputV1 = Readonly<{
  availableWidth: number;
  availableHeight?: number;
  canvasWidth: number;
  canvasHeight: number;
}>;

const positiveFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

export function createNestedCanvasFitV1(input: NestedCanvasFitInputV1): NestedCanvasFitV1 | null {
  if (
    !positiveFinite(input.availableWidth) ||
    !positiveFinite(input.canvasWidth) ||
    !positiveFinite(input.canvasHeight)
  )
    return null;
  const widthScale = input.availableWidth / input.canvasWidth;
  const heightScale = positiveFinite(input.availableHeight)
    ? input.availableHeight / input.canvasHeight
    : 1;
  const scale = Math.min(1, widthScale, heightScale);
  return Object.freeze({
    scale,
    reservedWidth: input.canvasWidth * scale,
    reservedHeight: input.canvasHeight * scale,
  });
}

const parseSnapshot = (input: unknown): BoardSnapshot => {
  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const parsed =
    record !== null && Object.hasOwn(record, 'document')
      ? (record.document as Record<string, unknown>).schemaVersion === 3
        ? BoardSnapshotParserV3.parse(input)
        : BoardSnapshotParserV2.parse(input)
      : BoardSnapshotParserV1.parse(input);
  if (!parsed.ok) throw new TypeError('board snapshot could not be verified');
  return parsed.data.value;
};

export const adaptSnapshotToPageRenderV2 = (
  input: unknown,
  selectedPageId: PageId,
): PageRenderInputV2 => {
  const snapshot = parseSnapshot(input);
  const document =
    'document' in snapshot
      ? snapshot.document
      : adaptLegacySceneToDocumentV2({ boardId: snapshot.boardId, scene: snapshot.scene });
  const page = document.pages.find((candidate) => candidate.pageId === selectedPageId);
  if (page === undefined) throw new TypeError('selected page is not present in the snapshot');
  const context: PageRendererContextV2 = {
    protocolVersion: 1,
    boardId: snapshot.boardId,
    revision: snapshot.revision,
    hitl: snapshot.hitl,
    artifacts: snapshot.artifacts,
    capabilities: snapshot.capabilities,
    lastEventSequence: snapshot.lastEventSequence,
    documentSchemaVersion:
      'document' in snapshot ? (snapshot.document.schemaVersion === 3 ? 3 : 2) : 1,
    selectedPageId,
  };
  return { page, context };
};
