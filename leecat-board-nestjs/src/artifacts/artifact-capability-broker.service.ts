import type { ArtifactReferenceV1, BoardId } from '@leecat-board/board-schema';

import { ArtifactBrokerError } from '../common/errors/artifact-broker.error.js';
import { BoardContractError } from '../common/errors/app-error.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { ArtifactNetworkFetchRequestV1 } from './artifact-network.dto.js';
import { ArtifactRepository } from './artifact.repository.js';
import { ArtifactAuditService } from './artifact-audit.service.js';

type ValidatedNetworkCommandV1 = {
  method: 'GET' | 'HEAD';
  url: URL;
};

const validateUrl = (request: ArtifactNetworkFetchRequestV1): ValidatedNetworkCommandV1 => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ArtifactBrokerError('INVALID_REQUEST', request.requestId);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || (url.port !== '' && url.port !== '443') || url.hostname === '' || url.hash !== '') {
    throw new ArtifactBrokerError('POLICY_DENIED', request.requestId);
  }
  return { method: request.method, url };
};

export class ArtifactCapabilityBrokerService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly artifacts: ArtifactRepository,
    private readonly audit: ArtifactAuditService,
  ) {}

  async networkFetch(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    artifact: ArtifactReferenceV1;
    request: ArtifactNetworkFetchRequestV1;
  }): Promise<never> {
    validateUrl(input.request);
    try {
      await this.accessPolicy.withAuthorizedBoardTransaction({
        principal: input.principal,
        operation: 'artifact.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      }, async (connection, context) => {
        const stored = await this.artifacts.readVersion(
          connection, input.boardId, input.artifact, false,
        );
        if (stored.runtime.status !== 'ready') {
          throw new ArtifactBrokerError('ARTIFACT_NOT_FOUND', input.request.requestId);
        }
        await this.audit.write(connection, {
          event: 'artifact.network.denied',
          context,
          boardPk: stored.boardPk,
          versionPk: stored.versionPk,
          operation: 'network',
          status: 'denied',
          eventSequence: stored.lastEventSequence,
          resultCode: 'policy_denied',
          capability: 'network.fetch',
        });
        return stored.manifest.requestedCapabilities.includes('network.fetch')
          && context.artifactCapabilityPolicy.allowedArtifactRequestCapabilities.includes('network.fetch');
      });
    } catch (error) {
      if (error instanceof BoardContractError && error.boardError.code === 'ARTIFACT_NOT_FOUND') {
        throw new ArtifactBrokerError('ARTIFACT_NOT_FOUND', input.request.requestId);
      }
      throw error;
    }
    throw new ArtifactBrokerError('POLICY_DENIED', input.request.requestId);
  }
}
