'use client';

import type { ArtifactRuntimeSummaryV1, TimestampV1 } from '@sceneboard/board-schema';
import { BoardRenderer } from '../renderer/BoardRenderer.js';
import type { PageRendererContextV2, RendererComponentV1 } from '../renderer/renderer-types.js';
import { ExportArtifactHost } from './ExportArtifactHost.js';
import { createExportMediaResolverV1 } from './export-media-resolver.js';
import type { ExportProjectionV1 } from './export-types.js';

const artifactRuntimes = (projection: ExportProjectionV1): ArtifactRuntimeSummaryV1[] =>
  projection.resources.flatMap((resource) =>
    resource.usage.kind === 'artifact'
      ? [
          {
            artifact: {
              artifactId: resource.usage.artifactId,
              versionId: resource.usage.versionId,
            },
            status: 'ready' as const,
            updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
            failure: null,
          },
        ]
      : [],
  );

export function ExportBoardRenderer({
  projection,
  pageIndex,
  runtimeOrigin,
}: {
  projection: ExportProjectionV1;
  pageIndex: number;
  runtimeOrigin: string;
}) {
  const page = projection.document.pages[pageIndex];
  if (page === undefined)
    return <section data-export-unsupported="page">Required page is unavailable.</section>;
  const artifacts = artifactRuntimes(projection);
  const context = {
    protocolVersion: 1,
    boardId: projection.boardId,
    revision: {
      revisionId: projection.revisionId,
      revisionNumber: projection.revisionNumber,
      createdAt: '1970-01-01T00:00:00.000Z',
      previousRevisionId: null,
      originType: 'system',
      sourceRevisionId: null,
      actor: {
        principalKind: 'service',
        principalId: 'export',
        grantId: null,
        scopes: [],
      },
    },
    hitl: [],
    artifacts,
    capabilities: {
      grantedCapabilities: [],
      deniedCapabilities: [],
      policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
    lastEventSequence: 1,
    documentSchemaVersion: 3,
    selectedPageId: page.pageId,
  } as unknown as PageRendererContextV2;
  const renderArtifact: RendererComponentV1<'content.artifact'> = ({ node, context }) => (
    <ExportArtifactHost
      projection={projection}
      runtimeOrigin={runtimeOrigin}
      node={node}
      context={context}
    />
  );
  const renderHitl: RendererComponentV1<'content.hitl'> = () => (
    <section data-export-unsupported="hitl">Interactive content cannot be exported.</section>
  );
  return (
    <main
      data-export-page={pageIndex}
      style={{
        width: projection.format.css.width,
        height: projection.format.css.height,
        overflow: 'hidden',
      }}
    >
      <BoardRenderer
        page={page}
        context={context}
        renderArtifact={renderArtifact}
        renderHitl={renderHitl}
        mediaResolver={createExportMediaResolverV1(projection)}
        emptyLabel=""
      />
    </main>
  );
}
