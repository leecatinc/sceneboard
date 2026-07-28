export type PageDisplayModeV1 = 'fit-page' | 'fit-width' | 'actual-size';

export type PagePointV1 = Readonly<{
  x: number;
  y: number;
}>;

export type PageRectV1 = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PageCanvasTransformV1 = Readonly<{
  mode: PageDisplayModeV1;
  scale: number;
  originX: number;
  originY: 0;
  moveX: number;
  canvasWidth: number;
  canvasHeight: number;
  reservedWidth: number;
  reservedHeight: number;
}>;

export type PageCanvasTransformInputV1 = Readonly<{
  mode: PageDisplayModeV1;
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  moveX?: number;
}>;

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

export function createPageCanvasTransformV1(
  input: PageCanvasTransformInputV1,
): PageCanvasTransformV1 | null {
  const { viewportWidth, viewportHeight, canvasWidth, canvasHeight } = input;
  if (
    !positiveFinite(viewportWidth) ||
    !positiveFinite(viewportHeight) ||
    !positiveFinite(canvasWidth) ||
    !positiveFinite(canvasHeight)
  ) {
    return null;
  }
  const scale =
    input.mode === 'fit-page'
      ? Math.min(viewportWidth / canvasWidth, viewportHeight / canvasHeight)
      : input.mode === 'fit-width'
        ? viewportWidth / canvasWidth
        : 1;
  const moveMinimum = Math.min(0, viewportWidth - canvasWidth);
  const requestedMoveX = Number.isFinite(input.moveX) ? (input.moveX ?? 0) : 0;
  const moveX =
    input.mode === 'actual-size' ? Math.min(0, Math.max(moveMinimum, requestedMoveX)) : 0;
  const reservedWidth = scale * canvasWidth;
  const reservedHeight = scale * canvasHeight;
  return Object.freeze({
    mode: input.mode,
    scale,
    originX: Math.max(0, (viewportWidth - reservedWidth) / 2),
    originY: 0,
    moveX,
    canvasWidth,
    canvasHeight,
    reservedWidth,
    reservedHeight,
  });
}

export function canvasPointToPageV1(
  transform: PageCanvasTransformV1,
  point: PagePointV1,
): PagePointV1 {
  return {
    x: transform.originX + transform.moveX + transform.scale * point.x,
    y: transform.originY + transform.scale * point.y,
  };
}

export function pagePointToCanvasV1(
  transform: PageCanvasTransformV1,
  point: PagePointV1,
): PagePointV1 {
  return {
    x: (point.x - transform.originX - transform.moveX) / transform.scale,
    y: (point.y - transform.originY) / transform.scale,
  };
}

export function canvasRectToPageV1(transform: PageCanvasTransformV1, rect: PageRectV1): PageRectV1 {
  const topLeft = canvasPointToPageV1(transform, rect);
  return {
    ...topLeft,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale,
  };
}

export function pageRectToCanvasV1(transform: PageCanvasTransformV1, rect: PageRectV1): PageRectV1 {
  const topLeft = pagePointToCanvasV1(transform, rect);
  return {
    ...topLeft,
    width: rect.width / transform.scale,
    height: rect.height / transform.scale,
  };
}

export function clientPointToPageV1(
  point: PagePointV1,
  pageViewportRect: Pick<PageRectV1, 'x' | 'y'>,
  scrollTop: number,
): PagePointV1 {
  return {
    x: point.x - pageViewportRect.x,
    y: point.y - pageViewportRect.y + scrollTop,
  };
}

export function visibleCanvasRectV1(
  transform: PageCanvasTransformV1,
  pageViewportRect: PageRectV1,
  scrollTop: number,
): PageRectV1 {
  const corners = [
    { x: pageViewportRect.x, y: pageViewportRect.y },
    { x: pageViewportRect.x + pageViewportRect.width, y: pageViewportRect.y },
    { x: pageViewportRect.x, y: pageViewportRect.y + pageViewportRect.height },
    {
      x: pageViewportRect.x + pageViewportRect.width,
      y: pageViewportRect.y + pageViewportRect.height,
    },
  ].map((point) =>
    pagePointToCanvasV1(transform, clientPointToPageV1(point, pageViewportRect, scrollTop)),
  );
  const left = Math.max(0, Math.min(...corners.map((point) => point.x)));
  const top = Math.max(0, Math.min(...corners.map((point) => point.y)));
  const right = Math.min(transform.canvasWidth, Math.max(...corners.map((point) => point.x)));
  const bottom = Math.min(transform.canvasHeight, Math.max(...corners.map((point) => point.y)));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}
