'use client';

import { decodeArtifactPackageV1 } from '@sceneboard/artifact-runtime/package';
import type {
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  TimestampV1,
} from '@sceneboard/board-schema';
import { ArtifactHost, type ArtifactLoadPortV1 } from '../artifact/index.js';
import type { RendererComponentV1 } from '../renderer/renderer-types.js';
import type { ExportProjectionV1 } from './export-types.js';

const runtime = (artifact: ArtifactReferenceV1): ArtifactRuntimeSummaryV1 => ({
  artifact,
  status: 'ready',
  updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
  failure: null,
});

export function ExportArtifactHost({
  projection,
  runtimeOrigin,
  node,
  context: _context,
}: {
  projection: ExportProjectionV1;
  runtimeOrigin: string;
  node: Parameters<RendererComponentV1<'content.artifact'>>[0]['node'];
  context: Parameters<RendererComponentV1<'content.artifact'>>[0]['context'];
}) {
  const resource = projection.resources.find(
    (candidate) =>
      candidate.usage.kind === 'artifact' &&
      candidate.usage.artifactId === node.artifact.artifactId &&
      candidate.usage.versionId === node.artifact.versionId,
  );
  if (resource === undefined)
    return <section data-export-unsupported="artifact">Required artifact is unavailable.</section>;
  const readPackage: ArtifactLoadPortV1['readPackage'] = async ({ signal }) => {
    const response = await fetch(resource.url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (
      response.status !== 200 ||
      response.headers.get('content-type') !== 'application/vnd.sceneboard.artifact-package+zip'
    )
      throw new Error('artifact package unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== resource.byteLength) throw new Error('artifact package size mismatch');
    return bytes;
  };
  const load: ArtifactLoadPortV1 = {
    readPackage,
    async readMetadata({ signal }) {
      const packageBytes = await readPackage({
        boardId: projection.boardId,
        artifact: node.artifact,
        signal,
      });
      const decoded = await decodeArtifactPackageV1(packageBytes);
      return { manifest: decoded.manifest, runtime: runtime(node.artifact) };
    },
  };
  return (
    <ArtifactHost
      boardId={projection.boardId}
      artifact={node.artifact}
      runtime={runtime(node.artifact)}
      runtimeOrigin={runtimeOrigin}
      routeEpoch={projection.revisionId}
      snapshotWatermark={projection.revisionNumber}
      load={load}
      hostInstanceId={node.id}
      incarnationKey={`${projection.revisionId}:${node.id}:${node.artifact.artifactId}:${node.artifact.versionId}`}
      viewMode="fit-page"
      showStopControl={false}
      onViewStateChange={() => undefined}
      onCaptureActiveChange={() => undefined}
    />
  );
}
