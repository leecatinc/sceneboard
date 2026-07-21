import type { PoolConnection } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';

export type ArtifactAuditEventName =
  | 'artifact.publication.created'
  | 'artifact.metadata.read'
  | 'artifact.package.read'
  | 'artifact.runtime.stopped'
  | 'artifact.network.denied'
  | 'artifact.usage.drift'
  | 'artifact.integrity.failed';

export class ArtifactAuditService {
  constructor(private readonly audit: AuditRepository) {}

  async write(
    connection: PoolConnection,
    input: {
      event: ArtifactAuditEventName;
      context: AuthorizedBoardContextV1 | null;
      boardPk?: string;
      versionPk?: string;
      operation:
        | 'publish'
        | 'metadata'
        | 'package'
        | 'stop'
        | 'network'
        | 'reconcile'
        | 'integrity';
      status: 'ready' | 'stopped' | 'denied' | 'drift' | 'failed';
      eventSequence?: number;
      resultCode: 'success' | 'policy_denied' | 'drift' | 'integrity_failure';
      capability?: 'network.fetch';
      drift?: boolean;
    },
  ): Promise<void> {
    const actor = input.context?.actor ?? null;
    await this.audit.writeMandatory(
      { connection },
      {
        event: input.event,
        actorPublicId: actor?.principalId ?? 'artifact-service-v1',
        userPublicId: actor?.principalKind === 'user' ? actor.principalId : null,
        sessionPublicId: null,
        clientPublicId: actor?.principalKind === 'mcp_client' ? actor.principalId : null,
        grantPublicId: actor?.grantId ?? null,
        subjectFingerprint: null,
        metadata: {
          ...(input.boardPk === undefined ? {} : { boardPk: input.boardPk }),
          ...(input.versionPk === undefined ? {} : { versionPk: input.versionPk }),
          actorKind: actor?.principalKind ?? 'service',
          operation: input.operation,
          status: input.status,
          ...(input.eventSequence === undefined ? {} : { eventSequence: input.eventSequence }),
          replayed: false,
          outcome: input.resultCode,
          ...(input.capability === undefined ? {} : { capability: input.capability }),
          ...(input.drift === undefined ? {} : { drift: input.drift }),
        },
      },
    );
  }
}
