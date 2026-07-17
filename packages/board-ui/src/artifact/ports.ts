import type {
  ArtifactManifestV1,
  ArtifactReferenceV1,
  ArtifactRuntimeSummaryV1,
  BoardId,
} from '@leecat-board/board-schema';

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
}

export type ArtifactHostInputV1 = {
  boardId: BoardId;
  artifact: ArtifactReferenceV1;
  runtime: ArtifactRuntimeSummaryV1;
  runtimeOrigin: string;
  routeEpoch: string;
  snapshotWatermark: number;
  load: ArtifactLoadPortV1;
};
