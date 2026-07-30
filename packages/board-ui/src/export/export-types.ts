import type {
  ArtifactId,
  ArtifactVersionId,
  BoardDocumentV3,
  BoardId,
  MediaId,
  PresentationFormatDescriptorV1,
  RevisionId,
} from '@sceneboard/board-schema';

export type ExportProjectionResourceV1 = Readonly<{
  sha256: string;
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'font/woff2'
    | 'application/vnd.sceneboard.artifact-package+zip';
  byteLength: number;
  url: string;
  usage:
    | Readonly<{ kind: 'media'; mediaId: MediaId }>
    | Readonly<{
        kind: 'artifact';
        artifactId: ArtifactId;
        versionId: ArtifactVersionId;
      }>
    | Readonly<{ kind: 'font'; family: 'Noto Sans KR'; subset: 'korean' | 'latin' }>;
}>;

export type ExportProjectionV1 = Readonly<{
  schemaVersion: 1;
  boardId: BoardId;
  revisionId: RevisionId;
  revisionNumber: number;
  document: BoardDocumentV3;
  format: PresentationFormatDescriptorV1;
  resources: readonly ExportProjectionResourceV1[];
}>;
