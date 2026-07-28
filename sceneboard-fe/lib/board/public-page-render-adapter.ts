import type { BoardPageV2, PageId, PublicBoardProjectionV1 } from '@sceneboard/board-schema';

import { resolveSelectedPageIdV1 } from './page-navigation';

export const resolvePublicSharePageV1 = (
  projection: PublicBoardProjectionV1,
  selectedPageId: PageId | null,
): { page: BoardPageV2; pageId: PageId; pageIndex: number } => {
  const pageId = resolveSelectedPageIdV1(projection.document, selectedPageId);
  const pageIndex = projection.document.pages.findIndex((page) => page.pageId === pageId);
  const page = projection.document.pages[pageIndex];
  if (page === undefined) throw new TypeError('public share page is unavailable');
  return { page, pageId, pageIndex };
};
