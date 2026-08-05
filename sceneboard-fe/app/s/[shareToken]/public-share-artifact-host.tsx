'use client';

import type {
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  BoardId,
  NodeId,
  TimestampV1,
} from '@sceneboard/board-schema';
import dynamic from 'next/dynamic';
import { useEffect, useMemo } from 'react';
import type { ArtifactPresentationPageChangeEventV1 } from '@sceneboard/board-ui/artifact';

import { useI18n } from '../../../components/i18n/I18nProvider';
import type { PublicArtifactPackageStoreV1 } from '../../../lib/api/public-share-artifact';

function ArtifactLoading() {
  const { t } = useI18n();
  return (
    <div className="artifact-fallback" role="status">
      {t('board.artifactPreparing')}
    </div>
  );
}

const PublicIsolatedArtifactHost = dynamic(
  () => import('@sceneboard/board-ui/artifact').then((module) => module.ArtifactHost),
  { ssr: false, loading: () => <ArtifactLoading /> },
);

const runtimeV1 = (artifact: ArtifactReferenceV1): ArtifactRuntimeSummaryV1 => ({
  artifact,
  status: 'ready',
  updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
  failure: null,
});

export function PublicShareArtifactHost({
  store,
  boardId,
  artifact,
  nodeId,
  runtimeOrigin,
  routeEpoch,
  snapshotWatermark,
  presentationActive,
  onPresentationPageChange,
}: Readonly<{
  store: PublicArtifactPackageStoreV1;
  boardId: BoardId;
  artifact: ArtifactReferenceV1;
  nodeId: NodeId;
  runtimeOrigin: string;
  routeEpoch: string;
  snapshotWatermark: number;
  presentationActive: boolean;
  onPresentationPageChange?(event: ArtifactPresentationPageChangeEventV1): void;
}>) {
  const artifactId = artifact.artifactId;
  const versionId = artifact.versionId;
  const stableArtifact = useMemo<ArtifactReferenceV1>(
    () => ({ artifactId, versionId }),
    [artifactId, versionId],
  );
  const runtime = useMemo(() => runtimeV1(stableArtifact), [stableArtifact]);
  const handle = useMemo(() => store.open(stableArtifact), [stableArtifact, store]);
  useEffect(() => () => handle.dispose(), [handle]);
  const incarnationKey = `${routeEpoch}:${nodeId}:${artifactId}:${versionId}`;

  return (
    <PublicIsolatedArtifactHost
      boardId={boardId}
      artifact={stableArtifact}
      runtime={runtime}
      runtimeOrigin={runtimeOrigin}
      routeEpoch={routeEpoch}
      snapshotWatermark={snapshotWatermark}
      load={handle.load}
      hostInstanceId={nodeId}
      incarnationKey={incarnationKey}
      viewMode="fit-page"
      presentationActive={presentationActive}
      {...(onPresentationPageChange === undefined ? {} : { onPresentationPageChange })}
      showStopControl={false}
      onViewStateChange={() => undefined}
      onCaptureActiveChange={() => undefined}
    />
  );
}
