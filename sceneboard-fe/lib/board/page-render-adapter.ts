import {
  adaptLegacySceneToDocumentV2,
  BoardSnapshotParserV1,
  BoardSnapshotParserV2,
  type BoardSnapshot,
  type PageId,
} from '@sceneboard/board-schema';
import type { BoardRendererPropsV2, PageRendererContextV2 } from '@sceneboard/board-ui/renderer';

export type PageRenderInputV2 = Pick<BoardRendererPropsV2, 'page' | 'context'>;

const parseSnapshot = (input: unknown): BoardSnapshot => {
  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const parsed =
    record !== null && Object.hasOwn(record, 'document')
      ? BoardSnapshotParserV2.parse(input)
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
    documentSchemaVersion: 'document' in snapshot ? 2 : 1,
    selectedPageId,
  };
  return { page, context };
};
