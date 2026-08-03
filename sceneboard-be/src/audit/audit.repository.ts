import { Injectable } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';

import type { AuditWriterPort, PersistenceTransaction } from '../auth/auth.persistence.js';
import { AuditEventCatalog, prepareAuditMetadata } from './audit-events.js';

const connectionOf = (transaction: PersistenceTransaction): PoolConnection =>
  transaction.connection as PoolConnection;

@Injectable()
export class AuditRepository implements AuditWriterPort {
  async writeMandatory(
    transaction: PersistenceTransaction,
    input: Parameters<AuditWriterPort['writeMandatory']>[1],
  ): Promise<void> {
    const metadata = prepareAuditMetadata(input.event, input.metadata ?? {});
    await connectionOf(transaction).execute(
      `
      INSERT INTO security_audit_events (
        event_type, outcome, actor_public_id, user_public_id, session_public_id,
        client_public_id, grant_public_id, pairing_public_id,
        subject_fingerprint, metadata, occurred_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
    `,
      [
        AuditEventCatalog[input.event],
        input.actorPublicId ?? null,
        input.userPublicId,
        input.sessionPublicId,
        input.clientPublicId ?? null,
        input.grantPublicId ?? null,
        input.pairingPublicId ?? null,
        input.subjectFingerprint,
        Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata),
      ],
    );
  }
}

export const observeMandatoryAuditWriteV1 = async ({
  input,
  observe,
}: {
  input: Parameters<AuditWriterPort['writeMandatory']>[1];
  observe(sql: string, parameters: readonly unknown[]): void;
}): Promise<void> => {
  const repository = new AuditRepository();
  const transaction = {
    connection: {
      execute: async (sql: string, parameters: readonly unknown[]) => {
        observe(sql, parameters);
        return [{ affectedRows: 1 }, undefined];
      },
    },
  } as unknown as PersistenceTransaction;
  try {
    await repository.writeMandatory(transaction, input);
  } catch (error) {
    observe('AUDIT_SECRET_FIELD_REJECTED', []);
    throw error;
  }
};
