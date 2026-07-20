import type { ArtifactNavigationIntentV1 } from '@leecat-board/artifact-runtime/bridge';

import type { ArtifactViewModeV1 } from './ports.js';

export const dispatchArtifactNavigationIntentV1 = (
  viewMode: ArtifactViewModeV1,
  intent: ArtifactNavigationIntentV1,
  listener: ((intent: ArtifactNavigationIntentV1) => void) | undefined,
): boolean => {
  if (viewMode !== 'actual' || listener === undefined) return false;
  listener(intent);
  return true;
};
