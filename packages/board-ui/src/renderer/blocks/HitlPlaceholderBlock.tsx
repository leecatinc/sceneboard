import type { RendererComponentV1 } from '../renderer-types.js';

export const HitlPlaceholderBlock: RendererComponentV1<'content.hitl'> = ({ node, context }) => {
  const interaction = context.snapshot.hitl.find(
    (item) => item.hitlRequestId === node.hitlRequestId,
  );
  if (interaction !== undefined && context.renderHitl !== undefined) {
    return context.renderHitl({ node, context, renderNode: () => null });
  }
  return (
    <section className="scene-block scene-attention" aria-labelledby={`hitl-${node.id}`}>
      <h3 id={`hitl-${node.id}`}>
        {interaction?.definition.title ?? node.title ?? 'Input requested'}
      </h3>
      <p>
        {interaction === undefined
          ? 'The interaction reference is unavailable.'
          : `State: ${interaction.state}`}
      </p>
      <button type="button" disabled aria-describedby={`hitl-help-${node.id}`}>
        Response unavailable
      </button>
      <p id={`hitl-help-${node.id}`} className="scene-help">
        Interactive responses are enabled in the D8 delivery stage.
      </p>
    </section>
  );
};
