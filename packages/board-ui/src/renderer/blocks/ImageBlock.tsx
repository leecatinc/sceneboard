import type { RendererComponentV1 } from '../renderer-types.js';

export const ImageBlock: RendererComponentV1<'content.image'> = ({ node, context }) => {
  const artifact = node.source.type === 'artifact.resource' ? node.source.artifact : null;
  const runtime =
    artifact === null
      ? undefined
      : context.artifacts.find(
          (item) =>
            item.artifact.artifactId === artifact.artifactId &&
            item.artifact.versionId === artifact.versionId,
        );
  return (
    <figure
      className="scene-block scene-placeholder"
      aria-hidden={node.decorative === true ? true : undefined}
    >
      <div className="scene-placeholder-icon" aria-hidden="true">
        ▧
      </div>
      <figcaption>
        <strong>{node.alt}</strong>
        {node.caption && <span>{node.caption}</span>}
        <span>Verified image delivery is unavailable in this release.</span>
        <span>
          {node.source.type === 'media' ? 'Media' : 'Artifact'} status:{' '}
          {runtime?.status ?? 'unavailable'}
        </span>
      </figcaption>
    </figure>
  );
};
