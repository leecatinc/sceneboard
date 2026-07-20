export const ARTIFACT_VIEW_MIN_SCALE = 0.1;
export const ARTIFACT_VIEW_MAX_SCALE = 4;
export const ARTIFACT_BASE_WIDTH = 1_200;
export const ARTIFACT_BASE_HEIGHT = 675;

export type ArtifactViewTransformV1 = Readonly<{
  scale: number;
  x: number;
  y: number;
}>;

export type ArtifactStageSizeV1 = Readonly<{
  width: number;
  height: number;
}>;

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const finiteTransform = (value: ArtifactViewTransformV1): boolean => finitePositive(value.scale) && Number.isFinite(value.x) && Number.isFinite(value.y);

export const centerArtifactViewV1 = (input: {
  availableWidth: number;
  availableHeight: number;
  contentWidth: number;
  contentHeight: number;
}): ArtifactViewTransformV1 => {
  if (![input.availableWidth, input.availableHeight, input.contentWidth, input.contentHeight].every(finitePositive)) return { scale: 1, x: 0, y: 0 };
  return {
    scale: 1,
    x: (input.availableWidth - input.contentWidth) / 2,
    y: (input.availableHeight - input.contentHeight) / 2,
  };
};

export const zoomArtifactViewV1 = (input: {
  transform: ArtifactViewTransformV1;
  pointerX: number;
  pointerY: number;
  deltaY: number;
}): ArtifactViewTransformV1 => {
  if (!finiteTransform(input.transform)
    || !Number.isFinite(input.pointerX)
    || !Number.isFinite(input.pointerY)
    || !Number.isFinite(input.deltaY)) return input.transform;
  const nextScale = Math.min(
    ARTIFACT_VIEW_MAX_SCALE,
    Math.max(ARTIFACT_VIEW_MIN_SCALE, input.transform.scale * Math.exp(-input.deltaY * 0.0015)),
  );
  const contentX = (input.pointerX - input.transform.x) / input.transform.scale;
  const contentY = (input.pointerY - input.transform.y) / input.transform.scale;
  return {
    scale: nextScale,
    x: input.pointerX - contentX * nextScale,
    y: input.pointerY - contentY * nextScale,
  };
};

export const panArtifactViewV1 = (
  transform: ArtifactViewTransformV1,
  deltaX: number,
  deltaY: number,
): ArtifactViewTransformV1 => finiteTransform(transform) && Number.isFinite(deltaX) && Number.isFinite(deltaY)
  ? { ...transform, x: transform.x + deltaX, y: transform.y + deltaY }
  : transform;

export const panArtifactViewByInnerDeltaV1 = (
  transform: ArtifactViewTransformV1,
  deltaX: number,
  deltaY: number,
): ArtifactViewTransformV1 => panArtifactViewV1(transform, deltaX * transform.scale, deltaY * transform.scale);

export const fitArtifactViewV1 = (input: {
  mode: 'fit-height' | 'fit-width';
  availableWidth: number;
  availableHeight: number;
  contentWidth: number;
  contentHeight: number;
}): ArtifactViewTransformV1 => {
  if (![input.availableWidth, input.availableHeight, input.contentWidth, input.contentHeight].every(finitePositive)) return { scale: 1, x: 0, y: 0 };
  const scale = input.mode === 'fit-height'
    ? input.availableHeight / input.contentHeight
    : input.availableWidth / input.contentWidth;
  const renderedWidth = input.contentWidth * scale;
  const renderedHeight = input.contentHeight * scale;
  return {
    scale,
    x: renderedWidth < input.availableWidth ? (input.availableWidth - renderedWidth) / 2 : 0,
    y: renderedHeight < input.availableHeight ? (input.availableHeight - renderedHeight) / 2 : 0,
  };
};

export const sizeArtifactStageV1 = (input: {
  mode: 'fit-height' | 'fit-width' | 'actual';
  availableWidth: number;
  availableHeight: number;
  contentWidth: number;
  contentHeight: number;
  scale: number;
}): ArtifactStageSizeV1 => {
  if (![input.availableWidth, input.availableHeight, input.contentWidth, input.contentHeight, input.scale].every(finitePositive)) {
    return { width: 1, height: 1 };
  }
  if (input.mode === 'actual') return { width: input.availableWidth, height: input.availableHeight };
  return {
    width: Math.max(input.availableWidth, input.contentWidth * input.scale),
    height: Math.max(input.availableHeight, input.contentHeight * input.scale),
  };
};

export const mapArtifactAnchorV1 = (input: {
  xMillionth: number;
  yMillionth: number;
  containerLeft: number;
  containerTop: number;
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
}): Readonly<{ x: number; y: number }> | null => {
  const values = Object.values(input);
  if (!values.every(Number.isFinite) || input.xMillionth < 0 || input.xMillionth > 1_000_000 || input.yMillionth < 0 || input.yMillionth > 1_000_000 || input.frameWidth <= 0 || input.frameHeight <= 0) return null;
  return {
    x: input.frameLeft - input.containerLeft + input.xMillionth / 1_000_000 * input.frameWidth,
    y: input.frameTop - input.containerTop + input.yMillionth / 1_000_000 * input.frameHeight,
  };
};
