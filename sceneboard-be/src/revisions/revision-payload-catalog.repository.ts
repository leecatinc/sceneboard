import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export interface RevisionPayloadCatalogBundleV1 {
  boardPk: string;
  revisionPk: string;
  retainedOrder: number;
  createdAtSql: string;
  actorAccountPk: string | null;
  actorClass: 'owner' | 'editor' | 'system';
  checkpoint: {
    schemaVersion: '1.0.0' | '2.0.0';
    codec: 'B';
    canonicalBytes: number;
    storedBytes: number;
    sha256: Uint8Array;
    payload: Uint8Array;
  };
}

const exactlyOne = (result: ResultSetHeader): void => {
  if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
};

/**
 * Owns the derived detached-payload and retained-catalog members of a revision bundle.
 * Callers must use the same connection as the immutable anchor, head, idempotency and
 * outbox writes; the surrounding access-policy transaction is the commit boundary.
 */
export class RevisionPayloadCatalogRepository {
  async persistRevisionBundle(
    connection: PoolConnection,
    bundle: RevisionPayloadCatalogBundleV1,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(bundle.retainedOrder) ||
      bundle.retainedOrder < 1 ||
      bundle.checkpoint.storedBytes !== bundle.checkpoint.payload.byteLength ||
      bundle.checkpoint.sha256.byteLength !== 32
    ) {
      throw new BoardPersistenceError('row_integrity');
    }

    const [payload] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_revision_payloads (
        revision_pk, schema_version, codec, canonical_bytes, stored_bytes,
        payload_sha256, payload, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
    `,
      [
        bundle.revisionPk,
        bundle.checkpoint.schemaVersion,
        bundle.checkpoint.codec,
        bundle.checkpoint.canonicalBytes,
        bundle.checkpoint.storedBytes,
        Buffer.from(bundle.checkpoint.sha256),
        Buffer.from(bundle.checkpoint.payload),
      ],
    );
    exactlyOne(payload);

    await connection.execute<ResultSetHeader>(
      `
      UPDATE board_revision_catalog
      SET is_head = 0
      WHERE board_pk = ? AND is_head = 1
    `,
      [bundle.boardPk],
    );
    const [catalog] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_revision_catalog (
        board_pk, revision_pk, retained_order, is_head, truncated_before,
        actor_account_pk, actor_class, created_at
      ) VALUES (?, ?, ?, 1, 0, ?, ?, ?)
    `,
      [
        bundle.boardPk,
        bundle.revisionPk,
        bundle.retainedOrder,
        bundle.actorAccountPk,
        bundle.actorClass,
        bundle.createdAtSql,
      ],
    );
    exactlyOne(catalog);
  }
}
