import type { MediaId } from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidMediaReference } from '../common/errors/board-error.factory.js';
import { encodeMediaIdForStorage } from './media-reference.types.js';
import { MediaOwnershipPort } from './media-ownership.port.js';
import { MediaWriterGate } from './media-writer-gate.js';

interface OwnershipRow extends RowDataPacket {
  mediaPk: string;
  mediaId: Buffer;
  status: 'active' | 'quarantined' | 'released';
}

export class MysqlMediaOwnershipProvider extends MediaOwnershipPort {
  constructor(private readonly gate: MediaWriterGate) {
    super();
  }

  async assertOwnedByBoard(
    connection: PoolConnection,
    boardPk: bigint,
    mediaIds: readonly MediaId[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    this.gate.assertMutationReady();
    const encoded = mediaIds.map(encodeMediaIdForStorage);
    const expected = new Set(encoded.map((value) => value.toString('base64')));
    const [rows] = await connection.query<OwnershipRow[]>(
      `
      SELECT CAST(media_pk AS CHAR) AS mediaPk, media_id AS mediaId, status
      FROM board_media
      WHERE board_pk = ? AND media_id IN (${encoded.map(() => '?').join(',')})
      ORDER BY media_pk ASC
      FOR UPDATE
    `,
      [boardPk.toString(), ...encoded],
    );
    if (
      rows.length !== encoded.length ||
      rows.some(
        (row) =>
          row.status !== 'active' ||
          !expected.has(row.mediaId.toString('base64')) ||
          !/^[1-9][0-9]*$/u.test(row.mediaPk),
      )
    )
      throw new BoardContractError(invalidMediaReference());
  }
}
