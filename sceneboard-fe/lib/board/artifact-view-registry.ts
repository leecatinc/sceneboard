import type {
  ArtifactResetCommandV1,
  ArtifactViewStateEventV1,
} from '@sceneboard/board-ui/artifact';

export type ArtifactViewRegistryEntryV1 = Readonly<{
  incarnationKey: string;
  scale: number;
  registrationOrder: number;
}>;

export type ArtifactViewRegistryStateV1 = Readonly<{
  entries: ReadonlyMap<string, ArtifactViewRegistryEntryV1>;
  selectedHostInstanceId: string | null;
  nextRegistrationOrder: number;
  resetEpoch: number;
  resetCommand: ArtifactResetCommandV1 | null;
}>;
export type ArtifactViewRegistryActionV1 =
  | Readonly<{ type: 'event'; event: ArtifactViewStateEventV1 }>
  | Readonly<{ type: 'reset' }>
  | Readonly<{ type: 'clear' }>;

export const createArtifactViewRegistryV1 = (): ArtifactViewRegistryStateV1 => ({
  entries: new Map(),
  selectedHostInstanceId: null,
  nextRegistrationOrder: 1,
  resetEpoch: 0,
  resetCommand: null,
});

const fallbackSelection = (
  entries: ReadonlyMap<string, ArtifactViewRegistryEntryV1>,
): string | null => {
  let selected: { id: string; order: number } | null = null;
  for (const [id, entry] of entries) {
    if (selected === null || entry.registrationOrder < selected.order)
      selected = { id, order: entry.registrationOrder };
  }
  return selected?.id ?? null;
};

const applyArtifactViewEventV1 = (
  state: ArtifactViewRegistryStateV1,
  event: ArtifactViewStateEventV1,
): ArtifactViewRegistryStateV1 => {
  if (!Number.isFinite(event.scale) || event.scale < 0.1 || event.scale > 4) return state;
  const entries = new Map(state.entries);
  const current = entries.get(event.hostInstanceId);
  if (event.phase === 'register') {
    const order =
      current?.incarnationKey === event.incarnationKey
        ? current.registrationOrder
        : state.nextRegistrationOrder;
    entries.set(event.hostInstanceId, {
      incarnationKey: event.incarnationKey,
      scale: event.scale,
      registrationOrder: order,
    });
    return {
      ...state,
      entries,
      selectedHostInstanceId: state.selectedHostInstanceId ?? event.hostInstanceId,
      nextRegistrationOrder:
        current?.incarnationKey === event.incarnationKey
          ? state.nextRegistrationOrder
          : state.nextRegistrationOrder + 1,
      resetCommand:
        current !== undefined &&
        current.incarnationKey !== event.incarnationKey &&
        state.resetCommand?.hostInstanceId === event.hostInstanceId
          ? null
          : state.resetCommand,
    };
  }
  if (current === undefined || current.incarnationKey !== event.incarnationKey) return state;
  if (event.phase === 'interaction') {
    entries.set(event.hostInstanceId, { ...current, scale: event.scale });
    return {
      ...state,
      entries,
      selectedHostInstanceId: event.hostInstanceId,
      resetCommand:
        state.resetCommand?.hostInstanceId === event.hostInstanceId &&
        state.resetCommand.incarnationKey === event.incarnationKey
          ? null
          : state.resetCommand,
    };
  }
  entries.delete(event.hostInstanceId);
  return {
    ...state,
    entries,
    selectedHostInstanceId:
      state.selectedHostInstanceId === event.hostInstanceId
        ? fallbackSelection(entries)
        : state.selectedHostInstanceId,
    resetCommand:
      state.resetCommand?.hostInstanceId === event.hostInstanceId &&
      state.resetCommand.incarnationKey === event.incarnationKey
        ? null
        : state.resetCommand,
  };
};

export const reduceArtifactViewRegistryV1 = (
  state: ArtifactViewRegistryStateV1,
  action: ArtifactViewRegistryActionV1,
): ArtifactViewRegistryStateV1 => {
  if (action.type === 'event') return applyArtifactViewEventV1(state, action.event);
  if (action.type === 'reset') return requestArtifactViewResetV1(state);
  return { ...createArtifactViewRegistryV1(), resetEpoch: state.resetEpoch };
};

export const requestArtifactViewResetV1 = (
  state: ArtifactViewRegistryStateV1,
): ArtifactViewRegistryStateV1 => {
  if (state.resetEpoch >= Number.MAX_SAFE_INTEGER || state.selectedHostInstanceId === null)
    return state;
  const selected = state.entries.get(state.selectedHostInstanceId);
  if (selected === undefined) return state;
  const resetEpoch = state.resetEpoch + 1;
  return {
    ...state,
    resetEpoch,
    resetCommand: {
      hostInstanceId: state.selectedHostInstanceId,
      incarnationKey: selected.incarnationKey,
      epoch: resetEpoch,
    },
  };
};

export const selectedArtifactZoomV1 = (state: ArtifactViewRegistryStateV1): number | null => {
  if (state.selectedHostInstanceId === null) return null;
  return state.entries.get(state.selectedHostInstanceId)?.scale ?? null;
};

export const canResetArtifactViewV1 = (state: ArtifactViewRegistryStateV1): boolean =>
  state.selectedHostInstanceId !== null &&
  state.entries.has(state.selectedHostInstanceId) &&
  state.resetEpoch < Number.MAX_SAFE_INTEGER;
