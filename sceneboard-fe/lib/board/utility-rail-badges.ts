// Utility-rail badge derivation — zero counts produce no badge (null) so the rail
// never advertises a non-actionable state. Icons always render; numeric badges only
// surface for meaningful (>0) counts.

export type UtilityRailBadgeInputV1 = {
  readonly aiCount: number;
  readonly interactionCount: number;
  readonly artifactCount: number;
};

export type UtilityRailBadgesV1 = {
  readonly ai: number | null;
  readonly interactions: number | null;
  readonly artifacts: number | null;
};

// Counts of zero or below normalize to no badge (null); only positive counts return a number.
const badgeValue = (count: number): number | null => (count > 0 ? count : null);

export const deriveUtilityRailBadgesV1 = (input: UtilityRailBadgeInputV1): UtilityRailBadgesV1 => ({
  ai: badgeValue(input.aiCount),
  interactions: badgeValue(input.interactionCount),
  artifacts: badgeValue(input.artifactCount),
});
