import { adaptLegacySceneToDocumentV2, type BoardSnapshotV1 } from '@sceneboard/board-schema';
import type { BoardRendererPropsV2 } from '../src/renderer/index.js';

export const rendererTestInputV2 = (
  snapshot: BoardSnapshotV1,
): Pick<BoardRendererPropsV2, 'page' | 'context'> => {
  const document = adaptLegacySceneToDocumentV2({
    boardId: snapshot.boardId,
    scene: snapshot.scene,
  });
  const page = document.pages[0];
  if (page === undefined) throw new TypeError('legacy renderer test page is missing');
  return {
    page,
    context: {
      protocolVersion: 1,
      boardId: snapshot.boardId,
      revision: snapshot.revision,
      hitl: snapshot.hitl,
      artifacts: snapshot.artifacts,
      capabilities: snapshot.capabilities,
      lastEventSequence: snapshot.lastEventSequence,
      documentSchemaVersion: 1,
      selectedPageId: page.pageId,
    },
  };
};
