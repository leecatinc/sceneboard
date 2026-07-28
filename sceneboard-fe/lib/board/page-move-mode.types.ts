import type { PageDisplayModeV1 } from './page-display-mode.types';

export type PageMovePointerStateV1 = 'idle' | 'pending' | 'horizontal-locked' | 'native-yielded';

export type PageMoveAdmissionInputV1 = Readonly<{
  moveToggle: boolean;
  displayMode: PageDisplayModeV1;
  pointerActive: boolean;
  isTrusted: boolean;
  pointerType: string;
  isPrimary: boolean;
  button: number;
  buttons: number;
  interactivePath: boolean;
  clientX: number;
  viewportLeft: number;
  viewportRight: number;
}>;

export type PageMoveHorizontalSessionV1 = Readonly<{
  pointerId: number;
  startClientX: number;
  baseX: number;
  latestClientX: number;
}>;

export type PageMoveTransitionStateV1 = Readonly<{
  choiceKind: 'implicit' | 'explicit';
  displayMode: PageDisplayModeV1;
  moveToggle: boolean;
  effectiveMove: boolean;
  x: number;
  pageScrollY: number;
  pointerState: PageMovePointerStateV1;
  raf: number | null;
}>;
