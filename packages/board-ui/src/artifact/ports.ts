import type {
  ArtifactManifestV1,
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  ArtifactRequestCapabilityV1,
  BoardId,
} from '@sceneboard/board-schema';
import type {
  ArtifactNavigationIntentV1,
  ArtifactPresentationPageChangeV1,
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

export type ArtifactViewModeV1 = 'fill' | 'fit-page' | 'fit-width' | 'actual';
export type ArtifactHostInstanceIdV1 = string;
export type ArtifactViewStateEventV1 = Readonly<{
  hostInstanceId: ArtifactHostInstanceIdV1;
  incarnationKey: string;
  phase: 'register' | 'interaction' | 'unregister';
  scale: number;
}>;
export type ArtifactPresentationPageChangeEventV1 = ArtifactPresentationPageChangeV1 &
  Readonly<{
    hostInstanceId: ArtifactHostInstanceIdV1;
    incarnationKey: string;
  }>;
export type ArtifactResetCommandV1 = Readonly<{
  hostInstanceId: ArtifactHostInstanceIdV1;
  incarnationKey: string;
  epoch: number;
}>;

type ArtifactHostBaseInputV1 = {
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
  presentationActive?: boolean;
  showStopControl?: boolean;
  stopSignal?: number;
  onNavigationIntent?(intent: ArtifactNavigationIntentV1): void;
  onResizeRequest?(request: ArtifactResizeRequestV1): void;
  onPresentationPageChange?(event: ArtifactPresentationPageChangeEventV1): void;
  onViewStateChange?(event: ArtifactViewStateEventV1): void;
  onCaptureActiveChange?(active: boolean): void;
  resetCommand?: ArtifactResetCommandV1 | null;
};

export type ArtifactHostInputV1 = ArtifactHostBaseInputV1 &
  (
    | Readonly<{
        allowedArtifactRequestCapabilities?: undefined;
        artifactCapabilityEpoch?: undefined;
      }>
    | Readonly<{
        allowedArtifactRequestCapabilities: readonly ArtifactRequestCapabilityV1[];
        artifactCapabilityEpoch: number;
      }>
  );
