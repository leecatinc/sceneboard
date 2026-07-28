import type { PageMoveAdmissionInputV1, PageMovePointerStateV1 } from './page-move-mode.types';

export const PAGE_MOVE_EDGE_BAND_PX = 24;
export const PAGE_MOVE_AXIS_THRESHOLD_PX = 12;
export const PAGE_MOVE_AXIS_RATIO = 1.5;

export function pageMoveMinimumXV1(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(contentWidth)) return 0;
  return Math.min(0, Math.max(0, viewportWidth) - Math.max(0, contentWidth));
}

export function clampPageMoveXV1(
  requestedX: number,
  viewportWidth: number,
  contentWidth: number,
): number {
  const minimum = pageMoveMinimumXV1(viewportWidth, contentWidth);
  if (!Number.isFinite(requestedX)) return 0;
  return Math.min(0, Math.max(minimum, requestedX));
}

export function pageMoveIsAvailableV1(
  displayMode: string,
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    displayMode === 'actual-size' &&
    Number.isFinite(viewportWidth) &&
    Number.isFinite(contentWidth) &&
    contentWidth > viewportWidth
  );
}

export function admitPageMovePointerDownV1(input: PageMoveAdmissionInputV1): boolean {
  const edgeDistance = Math.min(
    input.clientX - input.viewportLeft,
    input.viewportRight - input.clientX,
  );
  return (
    input.moveToggle &&
    input.displayMode === 'actual-size' &&
    !input.pointerActive &&
    input.isTrusted &&
    (input.pointerType === 'touch' || input.pointerType === 'pen') &&
    input.isPrimary &&
    input.button === 0 &&
    input.buttons === 1 &&
    !input.interactivePath &&
    edgeDistance >= PAGE_MOVE_EDGE_BAND_PX
  );
}

export function classifyPageMoveIntentV1(dx: number, dy: number): PageMovePointerStateV1 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'native-yielded';
  if (Math.hypot(dx, dy) < PAGE_MOVE_AXIS_THRESHOLD_PX) return 'pending';
  return Math.abs(dx) >= PAGE_MOVE_AXIS_THRESHOLD_PX &&
    Math.abs(dx) >= PAGE_MOVE_AXIS_RATIO * Math.abs(dy)
    ? 'horizontal-locked'
    : 'native-yielded';
}

export function nextPageMoveXV1(input: {
  baseX: number;
  latestClientX: number;
  startClientX: number;
  viewportWidth: number;
  contentWidth: number;
}): number {
  return clampPageMoveXV1(
    input.baseX + input.latestClientX - input.startClientX,
    input.viewportWidth,
    input.contentWidth,
  );
}
