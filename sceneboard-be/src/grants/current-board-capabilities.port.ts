import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  type ActorContextV1,
  type ArtifactRequestCapabilityV1,
  type BoardCapabilities,
  type BoardId,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { currentBoardCapabilitiesFromContext } from './current-board-capabilities.js';

interface CapabilityPolicyRow extends RowDataPacket {
  policyEpoch: Buffer;
  capability: string | null;
}

export class MysqlCurrentBoardCapabilitiesPort {
  async readAuthorizedAtCut(
    connection: PoolConnection,
    input: {
      actor: ActorContextV1;
      boardId: BoardId;
      lastEventSequence: number;
      checkpointSchemaVersion?: 1 | 2 | 3;
    },
  ): Promise<BoardCapabilities> {
    if (!Number.isSafeInteger(input.lastEventSequence) || input.lastEventSequence < 1) {
      throw new BoardPersistenceError('row_integrity');
    }
    const [rows] = await connection.execute<CapabilityPolicyRow[]>(
      `
      SELECT e.policy_epoch AS policyEpoch, p.capability
      FROM boards b
      JOIN board_artifact_capability_policy_epochs e ON e.board_pk = b.board_pk
      LEFT JOIN board_artifact_capability_policies p
        ON p.board_pk = b.board_pk AND p.owner_user_pk = b.owner_user_id
      WHERE b.public_id = ?
      ORDER BY p.capability ASC
    `,
      [input.boardId],
    );
    const epoch = rows[0]?.policyEpoch;
    if (
      !Buffer.isBuffer(epoch) ||
      epoch.byteLength !== 16 ||
      rows.some((row) => !Buffer.isBuffer(row.policyEpoch) || !row.policyEpoch.equals(epoch))
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    const known = new Set<string>(ARTIFACT_REQUEST_CAPABILITIES_V1);
    const allowed: ArtifactRequestCapabilityV1[] = [];
    for (const row of rows) {
      if (row.capability === null) continue;
      if (
        !known.has(row.capability) ||
        allowed.includes(row.capability as ArtifactRequestCapabilityV1)
      ) {
        throw new BoardPersistenceError('row_integrity');
      }
      allowed.push(row.capability as ArtifactRequestCapabilityV1);
    }
    allowed.sort();
    const context = {
      actor: input.actor,
      artifactCapabilityPolicy: {
        allowedArtifactRequestCapabilities: allowed,
        policyEpoch: epoch.toString('base64url'),
      },
    };
    return input.checkpointSchemaVersion === 3
      ? currentBoardCapabilitiesFromContext(context, 3)
      : input.checkpointSchemaVersion === 2
        ? currentBoardCapabilitiesFromContext(context, 2)
        : currentBoardCapabilitiesFromContext(context, 1);
  }
}
