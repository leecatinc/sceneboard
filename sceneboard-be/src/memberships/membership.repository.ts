import type { BoardMembershipRoleV1 } from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type LockedBoardMembershipV1 = {
  membershipPk: bigint;
  boardPk: bigint;
  accountPk: bigint;
  role: BoardMembershipRoleV1;
  version: number;
};

interface MembershipRow extends RowDataPacket {
  membershipPk: string;
  boardPk: string;
  accountPk: string;
  role: string;
  state: string;
  version: string;
}

const pk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new MembershipRowIntegrityError();
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new MembershipRowIntegrityError();
  return parsed;
};

const version = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new MembershipRowIntegrityError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new MembershipRowIntegrityError();
  return parsed;
};

const role = (value: string): BoardMembershipRoleV1 => {
  if (value !== 'owner' && value !== 'editor' && value !== 'viewer')
    throw new MembershipRowIntegrityError();
  return value;
};

export class MembershipRowIntegrityError extends Error {
  constructor() {
    super('board membership row integrity failure');
    this.name = 'MembershipRowIntegrityError';
  }
}

export class MembershipRepository {
  async createOwner(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      ownerAccountPk: bigint;
      createdAtSql: string;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_memberships (
        public_id, board_pk, account_pk, role, state, version,
        owner_account_pk, created_at, updated_at
      ) VALUES (
        CONCAT('membership_owner_', ?), ?, ?, 'owner', 'active', 1, ?, ?, ?
      )
    `,
      [
        input.boardPk.toString(),
        input.boardPk.toString(),
        input.ownerAccountPk.toString(),
        input.ownerAccountPk.toString(),
        input.createdAtSql,
        input.createdAtSql,
      ],
    );
    if (result.affectedRows !== 1) throw new MembershipRowIntegrityError();
  }

  async findActive(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      accountPk: bigint;
      lock: boolean;
    },
  ): Promise<LockedBoardMembershipV1 | null> {
    const [rows] = await connection.execute<MembershipRow[]>(
      `
      SELECT
        CAST(membership_pk AS CHAR) AS membershipPk,
        CAST(board_pk AS CHAR) AS boardPk,
        CAST(account_pk AS CHAR) AS accountPk,
        role,
        state,
        CAST(version AS CHAR) AS version
      FROM board_memberships
      WHERE board_pk = ? AND account_pk = ? AND state = 'active'
      LIMIT 1
      ${input.lock ? 'FOR UPDATE' : ''}
    `,
      [input.boardPk.toString(), input.accountPk.toString()],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.state !== 'active' ||
      pk(row.boardPk) !== input.boardPk ||
      pk(row.accountPk) !== input.accountPk
    ) {
      throw new MembershipRowIntegrityError();
    }
    return {
      membershipPk: pk(row.membershipPk),
      boardPk: input.boardPk,
      accountPk: input.accountPk,
      role: role(row.role),
      version: version(row.version),
    };
  }

  async adoptCanonicalOwner(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      ownerAccountPk: bigint;
    },
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_memberships (
        public_id, board_pk, account_pk, role, state, version,
        owner_account_pk, created_at, updated_at
      )
      SELECT
        CONCAT('membership_owner_', b.board_pk),
        b.board_pk,
        b.owner_user_id,
        'owner',
        'active',
        1,
        b.owner_user_id,
        b.created_at,
        GREATEST(b.created_at, b.updated_at)
      FROM boards b
      WHERE b.board_pk = ? AND b.owner_user_id = ?
      ON DUPLICATE KEY UPDATE membership_pk = LAST_INSERT_ID(membership_pk)
    `,
      [input.boardPk.toString(), input.ownerAccountPk.toString()],
    );
    if (result.affectedRows !== 0 && result.affectedRows !== 1 && result.affectedRows !== 2)
      throw new MembershipRowIntegrityError();
  }
}
