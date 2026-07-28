import type { RendererComponentV1 } from '../renderer-types.js';

export const ArtifactPlaceholderBlock: RendererComponentV1<'content.artifact'> = ({
  node,
  context,
}) => {
  const runtime = context.artifacts.find(
    (item) =>
      item.artifact.artifactId === node.artifact.artifactId &&
      item.artifact.versionId === node.artifact.versionId,
  );
  if (runtime !== undefined && context.renderArtifact !== undefined) {
    return context.renderArtifact({ node, context, renderNode: () => null });
  }
  return (
    <section className="scene-block scene-placeholder" aria-labelledby={`artifact-${node.id}`}>
      <h3 id={`artifact-${node.id}`}>{node.title ?? 'Isolated artifact'}</h3>
      <p>{node.fallbackText}</p>
      <p>Status: {runtime?.status ?? 'unavailable'} · execution disabled</p>
      <button type="button" disabled>
        Open artifact
      </button>
    </section>
  );
};
