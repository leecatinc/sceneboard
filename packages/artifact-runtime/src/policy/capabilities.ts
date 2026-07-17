import type { ArtifactRequestCapabilityV1 } from '@leecat-board/board-schema';

export type ArtifactCapabilityDecisionV1 =
  | { ok: true; capability: ArtifactRequestCapabilityV1 }
  | { ok: false; error: 'not_requested' | 'policy_denied' | 'revoked' | 'unavailable' };

export const decideArtifactCapabilityV1 = (input: {
  capability: ArtifactRequestCapabilityV1;
  manifestRequested: readonly ArtifactRequestCapabilityV1[];
  currentlyAllowed: readonly ArtifactRequestCapabilityV1[];
  policyEpochMatches: boolean;
  networkAllowlistConfigured?: boolean;
}): ArtifactCapabilityDecisionV1 => {
  if (!input.manifestRequested.includes(input.capability)) return { ok: false, error: 'not_requested' };
  if (!input.policyEpochMatches) return { ok: false, error: 'revoked' };
  if (!input.currentlyAllowed.includes(input.capability)) return { ok: false, error: 'policy_denied' };
  if (input.capability === 'network.fetch' && input.networkAllowlistConfigured !== true) {
    return { ok: false, error: 'unavailable' };
  }
  return { ok: true, capability: input.capability };
};
