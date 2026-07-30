import type { MediaResolverV1 } from '../renderer/renderer-types.js';
import type { ExportProjectionV1 } from './export-types.js';

export const createExportMediaResolverV1 = (projection: ExportProjectionV1): MediaResolverV1 => {
  const resources = new Map(
    projection.resources
      .filter(
        (
          resource,
        ): resource is typeof resource & {
          usage: Extract<typeof resource.usage, { kind: 'media' }>;
        } => resource.usage.kind === 'media',
      )
      .map((resource) => [resource.usage.mediaId, resource]),
  );
  return (input) => {
    if (input.boardId !== projection.boardId || input.revisionId !== projection.revisionId)
      return { error: 'unavailable' };
    const resource = resources.get(input.mediaId);
    if (
      resource === undefined ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(resource.mediaType)
    )
      return { error: 'unavailable' };
    return { url: resource.url };
  };
};
