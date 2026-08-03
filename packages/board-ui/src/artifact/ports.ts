import type {
  ArtifactManifestV1,
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  BoardId,
} from '@sceneboard/board-schema';
import type {
  ArtifactNavigationIntentV1,
  ArtifactResizeRequestV1,
} from '@sceneboard/artifact-runtime/bridge';

export type ArtifactMetadataLoadV1 = {
  manifest: ArtifactManifestV1;
  runtime: ArtifactRuntimeSummaryV1;
};

export interface ArtifactLoadPortV1 {
  readMetadata(input: {
    boardId: BoardId;
    artifact: ArtifactReferenceV1;
    signal: AbortSignal;
  }): Promise<ArtifactMetadataLoadV1>;
  readPackage(input: {
    boardId: BoardId;
    artifact: ArtifactReferenceV1;
    signal: AbortSignal;
  }): Promise<Uint8Array>;
  releasePackage?(bytes: Uint8Array): void;
}

export type ArtifactViewModeV1 = 'fit-page' | 'fit-width' | 'actual';
export type ArtifactHostInstanceIdV1 = string;
export type ArtifactViewStateEventV1 = Readonly<{
  hostInstanceId: ArtifactHostInstanceIdV1;
  incarnationKey: string;
  phase: 'register' | 'interaction' | 'unregister';
  scale: number;
}>;
export type ArtifactResetCommandV1 = Readonly<{
  hostInstanceId: ArtifactHostInstanceIdV1;
  incarnationKey: string;
  epoch: number;
}>;

export type ArtifactHostInputV1 = {
  boardId: BoardId;
  artifact: ArtifactReferenceV1;
  runtime: ArtifactRuntimeSummaryV1;
  runtimeOrigin: string;
  routeEpoch: string;
  snapshotWatermark: number;
  load: ArtifactLoadPortV1;
  hostInstanceId: ArtifactHostInstanceIdV1;
  incarnationKey: string;
  viewMode?: ArtifactViewModeV1;
  showStopControl?: boolean;
  stopSignal?: number;
  onNavigationIntent?(intent: ArtifactNavigationIntentV1): void;
  onResizeRequest?(request: ArtifactResizeRequestV1): void;
  onViewStateChange?(event: ArtifactViewStateEventV1): void;
  onCaptureActiveChange?(active: boolean): void;
  resetCommand?: ArtifactResetCommandV1 | null;
};
