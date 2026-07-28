import type { PageDisplayModeV1 } from './page-display-mode.types';

export const MOBILE_PAGE_BREAKPOINT_PX = 760;

export type ResponsivePageChoiceV1 = Readonly<{
  routeBoardId: string;
  choiceKind: 'implicit' | 'explicit';
  mode: PageDisplayModeV1;
}>;

export function responsivePageClassV1(width: number): 'mobile' | 'desktop' {
  return width <= MOBILE_PAGE_BREAKPOINT_PX ? 'mobile' : 'desktop';
}

export function implicitResponsivePageModeV1(width: number): PageDisplayModeV1 {
  return responsivePageClassV1(width) === 'mobile' ? 'fit-width' : 'fit-page';
}

export function createResponsivePageChoiceV1(
  routeBoardId: string,
  width: number,
): ResponsivePageChoiceV1 {
  return {
    routeBoardId,
    choiceKind: 'implicit',
    mode: implicitResponsivePageModeV1(width),
  };
}

export function resizeResponsivePageChoiceV1(
  state: ResponsivePageChoiceV1,
  width: number,
): ResponsivePageChoiceV1 {
  if (state.choiceKind === 'explicit') return state;
  const mode = implicitResponsivePageModeV1(width);
  return mode === state.mode ? state : { ...state, mode };
}

export function selectResponsivePageModeV1(
  state: ResponsivePageChoiceV1,
  mode: PageDisplayModeV1,
): ResponsivePageChoiceV1 {
  return { ...state, choiceKind: 'explicit', mode };
}
