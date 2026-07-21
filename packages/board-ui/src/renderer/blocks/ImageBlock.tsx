import type { RendererComponentV1 } from '../renderer-types.js';

export const ImageBlock: RendererComponentV1<'content.image'> = ({ node, context }) => {
  const runtime = context.snapshot.artifacts.find(
    (item) =>
      item.artifact.artifactId === node.source.artifact.artifactId &&
      item.artifact.versionId === node.source.artifact.versionId,
  );
  return (
    <figure className="scene-block scene-placeholder">
      <div className="scene-placeholder-icon" aria-hidden="true">
        ▧
      </div>
      <figcaption>
        <strong>{node.alt}</strong>
        {node.caption && <span>{node.caption}</span>}
        <span>Verified image delivery is unavailable in this release.</span>
        <span>Artifact status: {runtime?.status ?? 'unavailable'}</span>
      </figcaption>
    </figure>
  );
};
