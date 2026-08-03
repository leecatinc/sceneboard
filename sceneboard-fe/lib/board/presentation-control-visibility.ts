export const PRESENTATION_CONTROL_IDLE_MS = 2_000;

export type PresentationControlFocusCandidateV1 = Readonly<{
  disabled?: boolean;
  isConnected: boolean;
  focus: () => void;
}>;

const canReceivePresentationFocusV1 = (candidate: PresentationControlFocusCandidateV1): boolean =>
  candidate.isConnected && candidate.disabled !== true;

export function firstEnabledPresentationControlV1(
  candidates: Iterable<PresentationControlFocusCandidateV1>,
): PresentationControlFocusCandidateV1 | null {
  for (const candidate of candidates)
    if (canReceivePresentationFocusV1(candidate)) return candidate;
  return null;
}

export function focusPresentationControlV1(
  candidate: PresentationControlFocusCandidateV1 | null,
): boolean {
  if (candidate === null || !canReceivePresentationFocusV1(candidate)) return false;
  candidate.focus();
  return true;
}

export type PresentationControlVisibilityInputV1 = Readonly<{
  controlsFocusWithin: boolean;
  dialogOrMenuOpen: boolean;
  hitlInteractionActive: boolean;
  artifactCaptureActive: boolean;
  moveCaptureActive: boolean;
  prefersReducedMotion: boolean;
}>;

export type PresentationControlVisibilityStateV1 = Readonly<{
  phase: 'visible' | 'pending-hide' | 'hidden';
  generation: number;
  deadlineMs: number | null;
}>;

export const createPresentationControlVisibilityV1 = (): PresentationControlVisibilityStateV1 => ({
  phase: 'hidden',
  generation: 0,
  deadlineMs: null,
});

export const presentationControlsHeldV1 = (input: PresentationControlVisibilityInputV1): boolean =>
  Object.values(input).some(Boolean);

export function activityPresentationControlsV1(
  state: PresentationControlVisibilityStateV1,
  input: PresentationControlVisibilityInputV1,
  nowMs: number,
): PresentationControlVisibilityStateV1 {
  const generation = state.generation + 1;
  return presentationControlsHeldV1(input)
    ? { phase: 'visible', generation, deadlineMs: null }
    : {
        phase: 'pending-hide',
        generation,
        deadlineMs: nowMs + PRESENTATION_CONTROL_IDLE_MS,
      };
}

export function updatePresentationControlHoldsV1(
  state: PresentationControlVisibilityStateV1,
  previous: PresentationControlVisibilityInputV1,
  next: PresentationControlVisibilityInputV1,
  nowMs: number,
): PresentationControlVisibilityStateV1 {
  const wasHeld = presentationControlsHeldV1(previous);
  const held = presentationControlsHeldV1(next);
  if (held) return { phase: 'visible', generation: state.generation + 1, deadlineMs: null };
  if (wasHeld)
    return {
      phase: 'pending-hide',
      generation: state.generation + 1,
      deadlineMs: nowMs + PRESENTATION_CONTROL_IDLE_MS,
    };
  return state;
}

export function elapsePresentationControlsV1(
  state: PresentationControlVisibilityStateV1,
  input: PresentationControlVisibilityInputV1,
  generation: number,
  nowMs: number,
): PresentationControlVisibilityStateV1 {
  if (
    state.phase !== 'pending-hide' ||
    state.generation !== generation ||
    state.deadlineMs === null ||
    nowMs < state.deadlineMs ||
    presentationControlsHeldV1(input)
  )
    return state;
  return { phase: 'hidden', generation: state.generation + 1, deadlineMs: null };
}
