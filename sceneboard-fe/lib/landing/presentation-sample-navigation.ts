export type PresentationSampleNavigationInput = Readonly<{
  isPrimaryClick: boolean;
  hasModifierKey: boolean;
  activationSource: 'keyboard' | 'mouse' | 'touch';
}>;

export const shouldUseCurrentTabForPresentationSample = (
  input: PresentationSampleNavigationInput,
): boolean => input.isPrimaryClick && !input.hasModifierKey && input.activationSource === 'touch';
