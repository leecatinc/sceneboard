import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  MediaIdParserV1,
  PageIdParserV1,
} from '@sceneboard/board-schema';
import type { MediaResolverV1 } from '@sceneboard/board-ui/renderer';

const UNAVAILABLE = Object.freeze({ error: 'unavailable' as const });

export const createAccountMediaResolverV1 = (
  visible: Readonly<{
    boardId: string;
    revisionId: string;
  }>,
): MediaResolverV1 => {
  const boardId = BoardIdParserV1.parse(visible.boardId);
  const revisionId = GlobalIdStringParserV1.parse(visible.revisionId);
  if (!boardId.ok || !revisionId.ok) return () => UNAVAILABLE;

  return (input) => {
    if (!('mediaId' in input)) return UNAVAILABLE;
    const mediaId = MediaIdParserV1.parse(input.mediaId);
    const pageId = PageIdParserV1.parse(input.pageId);
    if (
      !mediaId.ok ||
      !pageId.ok ||
      input.boardId !== boardId.data.value ||
      input.revisionId !== revisionId.data.value
    )
      return UNAVAILABLE;
    return Object.freeze({
      url: `/api/v1/boards/${encodeURIComponent(boardId.data.value)}/revisions/${encodeURIComponent(revisionId.data.value)}/media/${encodeURIComponent(mediaId.data.value)}`,
    });
  };
};
