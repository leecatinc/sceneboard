export type ArtifactMeasuredCandidateV1 = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  scrollWidth: number;
  scrollHeight: number;
}>;

export const measureArtifactContentSizeV1 = (
  origin: Readonly<{ left: number; top: number }>,
  candidates: readonly ArtifactMeasuredCandidateV1[],
): Readonly<{ width: number; height: number }> => {
  if (candidates.length === 0) return { width: 1_200, height: 675 };
  const right = Math.max(
    ...candidates.map((candidate) =>
      Math.max(candidate.right - origin.left, candidate.left - origin.left + candidate.scrollWidth),
    ),
  );
  const bottom = Math.max(
    ...candidates.map((candidate) =>
      Math.max(candidate.bottom - origin.top, candidate.top - origin.top + candidate.scrollHeight),
    ),
  );
  return {
    width: Math.min(16_384, Math.max(1, Math.ceil(Math.max(1, right)))),
    height: Math.min(16_384, Math.max(1, Math.ceil(Math.max(1, bottom)))),
  };
};
