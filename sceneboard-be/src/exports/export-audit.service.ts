import type { PoolConnection } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { ExportFailureCodeV1 } from './export-errors.js';
import type { ExportFormatV1 } from './export-request.schema.js';

type ExportAuditBaseV1 = Readonly<{
  principal: ResolvedBoardPrincipalV1;
  correlationId: string;
  format: ExportFormatV1;
  revisionNumber: number;
}>;

export class ExportAuditServiceV1 {
  constructor(private readonly audit: AuditRepository) {}

  async started(connection: PoolConnection, input: ExportAuditBaseV1): Promise<void> {
    await this.write(connection, 'export.started', input, {});
  }

  async completed(
    connection: PoolConnection,
    input: ExportAuditBaseV1 & { bytes: number },
  ): Promise<void> {
    await this.write(connection, 'export.completed', input, { bytes: input.bytes });
  }

  async failed(
    connection: PoolConnection,
    input: ExportAuditBaseV1 & { reason: ExportFailureCodeV1 },
  ): Promise<void> {
    await this.write(connection, 'export.failed', input, { reason: input.reason });
  }

  private async write(
    connection: PoolConnection,
    event: 'export.started' | 'export.completed' | 'export.failed',
    input: ExportAuditBaseV1,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const actor = input.principal.actor;
    await this.audit.writeMandatory(
      { connection },
      {
        event,
        actorPublicId: actor.principalId,
        userPublicId: actor.principalKind === 'user' ? actor.principalId : null,
        sessionPublicId: null,
        clientPublicId: actor.principalKind === 'mcp_client' ? actor.principalId : null,
        grantPublicId: actor.grantId,
        subjectFingerprint: null,
        metadata: {
          correlationId: input.correlationId,
          format: input.format,
          revisionNumber: input.revisionNumber,
          ...extra,
        },
      },
    );
  }
}
