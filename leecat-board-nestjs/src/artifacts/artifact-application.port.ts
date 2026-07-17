import type {
  BoardOperationResultV1,
  ArtifactReferenceV1,
  BoardId,
  IdempotencyKey,
  MutationResultV1,
  RequestId,
  RevisionId,
  ShortText,
} from '@leecat-board/board-schema';

import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { BoardArtifactPutSourceV1 } from './artifact-http.dto.js';

export type ArtifactGetRequestV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'artifact.get';
  boardId: BoardId;
  artifact: ArtifactReferenceV1;
};

export type ArtifactStopRequestV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  command: { type: 'artifact.stop'; artifact: ArtifactReferenceV1; reason?: ShortText };
};

export abstract class ArtifactApplicationPortV1 {
  abstract publish(input: {
    principal: ResolvedBoardPrincipalV1;
    requestId: RequestId;
    source: BoardArtifactPutSourceV1;
  }): Promise<MutationResultV1>;

  abstract get(input: {
    principal: ResolvedBoardPrincipalV1;
    request: ArtifactGetRequestV1;
  }): Promise<BoardOperationResultV1>;

  abstract getPackage(input: {
    principal: ResolvedBoardPrincipalV1;
    request: ArtifactGetRequestV1;
  }): Promise<Buffer>;

  abstract stop(input: {
    principal: ResolvedBoardPrincipalV1;
    request: ArtifactStopRequestV1;
  }): Promise<MutationResultV1>;
}
