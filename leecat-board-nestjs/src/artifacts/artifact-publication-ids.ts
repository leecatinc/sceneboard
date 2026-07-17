import { createHash } from 'node:crypto';

import {
  canonicalizeJsonV1,
  type ArtifactId,
  type ArtifactVersionId,
  type BoardId,
  type IdempotencyKey,
} from '@leecat-board/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';

export type ArtifactPublicationIdsV1 = {
  artifactId: ArtifactId;
  versionId: ArtifactVersionId;
};

const derive = (
  principal: ResolvedBoardPrincipalV1,
  boardId: BoardId,
  idempotencyKey: IdempotencyKey,
  purpose: 'artifact' | 'version',
): string => {
  const canonical = canonicalizeJsonV1({
    principalKind: principal.actor.principalKind,
    principalId: principal.actor.principalId,
    grantId: principal.actor.grantId,
    boardId,
    idempotencyKey,
    purpose,
  });
  if (!canonical.ok) throw new BoardContractError(canonical.error);
  return createHash('sha256')
    .update('leecat-board:artifact-publication:v1\0', 'utf8')
    .update(canonical.data.canonicalBytes)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
};

export const deriveArtifactPublicationIdsV1 = (input: {
  principal: ResolvedBoardPrincipalV1;
  boardId: BoardId;
  idempotencyKey: IdempotencyKey;
  artifactId: ArtifactId | null;
}): ArtifactPublicationIdsV1 => ({
  artifactId: (input.artifactId ?? derive(
    input.principal, input.boardId, input.idempotencyKey, 'artifact',
  )) as ArtifactId,
  versionId: derive(
    input.principal, input.boardId, input.idempotencyKey, 'version',
  ) as ArtifactVersionId,
});
