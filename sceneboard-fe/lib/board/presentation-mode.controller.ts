export type PresentationModeV1 = 'inactive' | 'requesting' | 'fullscreen' | 'focus';

export type PresentationLifecycleIdentityV1 = Readonly<{
  boardId: string;
  revisionId: string;
  routeEpoch: string;
  pageElementEpoch: number;
  requestEpoch: number;
}>;

export type PresentationLifecycleStateV1 = Readonly<{
  mode: PresentationModeV1;
  identity: PresentationLifecycleIdentityV1 | null;
}>;

export type PresentationLifecycleEventV1 =
  | Readonly<{ type: 'enter'; identity: PresentationLifecycleIdentityV1 }>
  | Readonly<{
      type: 'fullscreen-entered' | 'fallback-focus' | 'matching-exit';
      identity: PresentationLifecycleIdentityV1;
    }>
  | Readonly<{ type: 'invalidate' }>;

export const createPresentationLifecycleStateV1 = (): PresentationLifecycleStateV1 => ({
  mode: 'inactive',
  identity: null,
});

export function samePresentationIdentityV1(
  left: PresentationLifecycleIdentityV1 | null,
  right: PresentationLifecycleIdentityV1 | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.boardId === right.boardId &&
    left.revisionId === right.revisionId &&
    left.routeEpoch === right.routeEpoch &&
    left.pageElementEpoch === right.pageElementEpoch &&
    left.requestEpoch === right.requestEpoch
  );
}

export function reducePresentationLifecycleV1(
  state: PresentationLifecycleStateV1,
  event: PresentationLifecycleEventV1,
): PresentationLifecycleStateV1 {
  if (event.type === 'invalidate') return createPresentationLifecycleStateV1();
  if (event.type === 'enter') return { mode: 'requesting', identity: event.identity };
  if (!samePresentationIdentityV1(state.identity, event.identity)) return state;
  if (event.type === 'fullscreen-entered') return { mode: 'fullscreen', identity: state.identity };
  if (event.type === 'fallback-focus') return { mode: 'focus', identity: state.identity };
  return createPresentationLifecycleStateV1();
}

export function presentationSettlementIsCurrentV1(input: {
  expected: PresentationLifecycleIdentityV1;
  current: PresentationLifecycleIdentityV1 | null;
  capturedPage: Element;
  currentPage: Element | null;
}): boolean {
  return (
    samePresentationIdentityV1(input.expected, input.current) &&
    input.capturedPage.isConnected &&
    input.capturedPage === input.currentPage
  );
}
