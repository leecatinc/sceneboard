import type { PageDisplayModeV1 } from './page-display-mode.types';

export type PageViewportClassV1 = 'desktop' | 'mobile';

export type PageDisplayModeControllerInputV1 = Readonly<{
  routeBoardId: string;
  viewportClass: PageViewportClassV1;
  userSelection: PageDisplayModeV1 | null;
}>;

export function defaultPageDisplayModeV1(viewportClass: PageViewportClassV1): PageDisplayModeV1 {
  return viewportClass === 'mobile' ? 'fit-width' : 'fit-page';
}

export function resolvePageDisplayModeV1(
  input: PageDisplayModeControllerInputV1,
): PageDisplayModeV1 {
  return input.userSelection ?? defaultPageDisplayModeV1(input.viewportClass);
}
