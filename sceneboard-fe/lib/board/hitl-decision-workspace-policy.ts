import type { HitlInteractionV1 } from '@sceneboard/board-schema';

const LONG_BODY_THRESHOLD = 1_200;
const MANY_CONTROLS_THRESHOLD = 6;

export const shouldPreferExpandedDecisionWorkspaceV1 = (
  interactions: ReadonlyArray<HitlInteractionV1>,
): boolean =>
  interactions.some((interaction) => {
    const definition = interaction.definition;
    const bodyLength = 'body' in definition ? (definition.body?.length ?? 0) : 0;
    const controlCount =
      definition.kind === 'choice'
        ? definition.options.length
        : definition.kind === 'form'
          ? definition.fields.length
          : 0;
    return bodyLength > LONG_BODY_THRESHOLD || controlCount > MANY_CONTROLS_THRESHOLD;
  });
