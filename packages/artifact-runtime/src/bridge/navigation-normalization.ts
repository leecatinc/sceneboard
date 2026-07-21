const MILLION = 1_000_000;
const nativeNumberIsFinite = Number.isFinite;
const nativeMathRound = Math.round;
const nativeMathMax = Math.max;
const nativeMathMin = Math.min;

export const encodeArtifactCoordinateMillionthV1 = (
  coordinate: number,
  extent: number,
  fallback: number,
): number => {
  const usableExtent = nativeNumberIsFinite(extent) && extent > 0 ? extent : fallback;
  return nativeMathRound(nativeMathMax(0, nativeMathMin(1, coordinate / usableExtent)) * MILLION);
};

export const normalizeArtifactWheelDeltaV1 = (
  deltaY: number,
  deltaMode: number,
  innerHeight: number,
): number | null => {
  if (!nativeNumberIsFinite(deltaY) || deltaY === 0) return null;
  const pageHeight = nativeNumberIsFinite(innerHeight) && innerHeight > 0 ? innerHeight : 675;
  const factor = deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1;
  const normalized = nativeMathMax(-16_384, nativeMathMin(16_384, deltaY * factor));
  return normalized === 0 ? null : normalized;
};

export const artifactPointerAnchorV1 = (
  clientX: number,
  clientY: number,
  innerWidth: number,
  innerHeight: number,
): Readonly<{ xMillionth: number; yMillionth: number }> => ({
  xMillionth: encodeArtifactCoordinateMillionthV1(clientX, innerWidth, 1_200),
  yMillionth: encodeArtifactCoordinateMillionthV1(clientY, innerHeight, 675),
});
