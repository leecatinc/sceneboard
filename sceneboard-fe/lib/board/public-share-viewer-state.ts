import type { PublicShareStateV1 } from '@sceneboard/board-schema';

export const PUBLIC_SHARE_EARLY_REFRESH_MS_V1 = 30_000;
export const PUBLIC_SHARE_HARD_EXPIRY_MS_V1 = 55_000;

export type PublicShareReadyStateV1 = Extract<PublicShareStateV1, { state: 'ready' }>;

export type PublicShareViewerIdentityV1 = Readonly<{
  routeEpoch: string;
  contextId: string;
  revisionId: string;
  publicationGeneration: number;
  accessGeneration: number;
  requestEpoch: number;
}>;

export const publicShareViewerIdentityV1 = (
  routeEpoch: string,
  state: PublicShareReadyStateV1,
  requestEpoch: number,
): PublicShareViewerIdentityV1 => ({
  routeEpoch,
  contextId: state.context.contextId,
  revisionId: state.projection.revisionId,
  publicationGeneration: state.projection.publicationGeneration,
  accessGeneration: state.projection.accessGeneration,
  requestEpoch,
});

export const samePublicShareViewerIdentityV1 = (
  left: PublicShareViewerIdentityV1,
  right: PublicShareViewerIdentityV1,
): boolean =>
  left.routeEpoch === right.routeEpoch &&
  left.contextId === right.contextId &&
  left.revisionId === right.revisionId &&
  left.publicationGeneration === right.publicationGeneration &&
  left.accessGeneration === right.accessGeneration &&
  left.requestEpoch === right.requestEpoch;

export const publicShareProjectionTupleMatchesV1 = (
  displayed: PublicShareReadyStateV1,
  candidate: PublicShareReadyStateV1,
): boolean =>
  displayed.projection.shareId === candidate.projection.shareId &&
  displayed.projection.boardId === candidate.projection.boardId &&
  displayed.projection.revisionId === candidate.projection.revisionId &&
  displayed.projection.publicationGeneration === candidate.projection.publicationGeneration &&
  displayed.projection.accessGeneration === candidate.projection.accessGeneration;

export const publicShareAnnotationPageKeyV1 = (
  state: PublicShareReadyStateV1,
  pageId: string,
): string =>
  [
    state.projection.shareId,
    state.projection.revisionId,
    state.projection.publicationGeneration,
    state.projection.accessGeneration,
    pageId,
  ].join('\u0000');

export const publicShareArtifactRouteKeyV1 = (state: PublicShareReadyStateV1): string =>
  [
    state.projection.shareId,
    state.projection.boardId,
    state.projection.revisionId,
    state.projection.publicationGeneration,
    state.projection.accessGeneration,
  ].join('\u0000');

export const publicShareViewerDeadlinesV1 = (
  requestStartedAt: number,
): { earlyRefreshAt: number; hardExpiryAt: number } => {
  if (!Number.isFinite(requestStartedAt) || requestStartedAt < 0)
    throw new TypeError('public share monotonic start is invalid');
  return {
    earlyRefreshAt: requestStartedAt + PUBLIC_SHARE_EARLY_REFRESH_MS_V1,
    hardExpiryAt: requestStartedAt + PUBLIC_SHARE_HARD_EXPIRY_MS_V1,
  };
};
