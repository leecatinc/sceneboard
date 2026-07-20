import type { ArtifactNavigationIntentV1, ArtifactResizeRequestV1 } from '@leecat-board/artifact-runtime/bridge';

import type { ArtifactHostInputV1 } from './ports.js';

export type ArtifactResizeQueueV1 = Readonly<{
  observerAdmitted: boolean;
  explicitAdmitted: boolean;
  pending: ArtifactResizeRequestV1 | null;
}>;

export const createArtifactResizeQueueV1 = (): ArtifactResizeQueueV1 => ({
  observerAdmitted: false,
  explicitAdmitted: false,
  pending: null,
});

const validSize = (value: ArtifactResizeRequestV1): boolean => Number.isInteger(value.width)
  && value.width >= 1
  && value.width <= 16_384
  && Number.isInteger(value.height)
  && value.height >= 1
  && value.height <= 16_384
  && (value.source === 'explicit' || value.source === 'observer');

export const admitArtifactResizeRequestV1 = (
  state: ArtifactResizeQueueV1,
  request: ArtifactResizeRequestV1,
): Readonly<{ state: ArtifactResizeQueueV1; accepted: boolean }> => {
  if (!validSize(request)) return { state, accepted: false };
  if (request.source === 'observer') {
    if (state.observerAdmitted || state.explicitAdmitted || state.pending?.source === 'explicit') {
      return { state, accepted: false };
    }
    return {
      accepted: true,
      state: { ...state, observerAdmitted: true, pending: request },
    };
  }
  return {
    accepted: true,
    state: { ...state, explicitAdmitted: true, pending: request },
  };
};

export const takePendingArtifactResizeV1 = (
  state: ArtifactResizeQueueV1,
): Readonly<{ state: ArtifactResizeQueueV1; pending: ArtifactResizeRequestV1 | null }> => ({
  pending: state.pending,
  state: { ...state, pending: null },
});

export const changesArtifactSizeV1 = (
  current: Readonly<{ width: number; height: number }>,
  pending: ArtifactResizeRequestV1,
): boolean => current.width !== pending.width || current.height !== pending.height;

const exactResetEpoch = (input: ArtifactHostInputV1): number | null => {
  const command = input.resetCommand;
  if (command === null || command === undefined
    || command.hostInstanceId !== input.hostInstanceId
    || command.incarnationKey !== input.incarnationKey
    || !Number.isSafeInteger(command.epoch)
    || command.epoch < 1
    || command.epoch > Number.MAX_SAFE_INTEGER) return null;
  return command.epoch;
};

export const advanceArtifactResetEpochV1 = (
  current: number,
  input: ArtifactHostInputV1,
): Readonly<{ epoch: number; advanced: boolean }> => {
  const admitted = exactResetEpoch(input);
  if (admitted === null || admitted <= current) return { epoch: current, advanced: false };
  return { epoch: admitted, advanced: true };
};

export const applyArtifactPanIntentV1 = (
  panning: boolean,
  intent: ArtifactNavigationIntentV1,
): Readonly<{ panning: boolean; shouldMove: boolean }> => {
  if (intent.type === 'artifact.navigation.pan.start') return { panning: true, shouldMove: false };
  if (intent.type === 'artifact.navigation.pan.move') return { panning, shouldMove: true };
  if (intent.type === 'artifact.navigation.pan.end') return { panning: false, shouldMove: true };
  if (intent.type === 'artifact.navigation.pan.cancel') return { panning: false, shouldMove: false };
  return { panning, shouldMove: false };
};
