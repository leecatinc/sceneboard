import { createHash } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  type BoardEventEnvelopeV1,
  type InvitationRoleV1,
  type InvitationStateV1,
  type MemberCandidateV1,
  type PrincipalId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import type { AuditEventName } from '../audit/audit-events.js';
import {
  formatPublicUuidV4,
  generatePublicUuidV4,
  parsePublicUuidV4,
} from '../common/ids/public-uuid.storage.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';

export type LockedInvitation = {
  invitationPk: bigint;
  inviteId: string;
  boardPk: bigint;
  boardId: string;
  boardTitle: string;
  ownerAccountPk: bigint;
  emailNormalized: string;
  role: InvitationRoleV1;
  state: InvitationStateV1;
  tokenDigest: Buffer;
  version: number;
  acceptedAccountPk: bigint | null;
  expiresAtSql: string;
};

export type LockedAccount = {
  accountPk: bigint;
  accountId: string;
  emailNormalized: string;
  displayName: string;
};

export type LockedManagedMembership = {
  membershipPk: bigint;
  memberId: string;
  accountPk: bigint;
  accountId: string;
  role: 'owner' | InvitationRoleV1;
  state: 'active' | 'inactive';
  version: number;
};

interface InvitationRow extends RowDataPacket {
  invitationPk: string;
  inviteId: string;
  boardPk: string;
  boardId: string;
  boardTitle: string;
  ownerAccountPk: string;
  emailNormalized: string;
  role: string;
  state: string;
  tokenDigest: Buffer;
  version: string;
  acceptedAccountPk: string | null;
  expiresAt: string;
}

interface AccountRow extends RowDataPacket {
  accountPk: string;
  accountId: string;
  emailNormalized: string;
  displayName: string;
}

interface CandidateRow extends RowDataPacket {
  accountId: string;
  emailNormalized: string;
  displayName: string;
}

interface MembershipRow extends RowDataPacket {
  membershipPk: string;
  memberId: string;
  accountPk: string;
  accountId: string;
  role: string;
  state: string;
  version: string;
}

export type LockedInvitationBoard = {
  boardPk: string;
  boardId: string;
  ownerAccountPk: string;
  capabilityEpoch: string;
};

interface BoardRow extends RowDataPacket, LockedInvitationBoard {}

interface HeadRow extends RowDataPacket {
  revisionId: Buffer;
  lastEventSequence: string;
}

const databasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new InvitationPersistenceError();
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new InvitationPersistenceError();
  return parsed;
};

const safeNumber = (value: string, allowZero = false): number => {
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) throw new InvitationPersistenceError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed < 1))
    throw new InvitationPersistenceError();
  return parsed;
};

const invitationRole = (value: string): InvitationRoleV1 => {
  if (value !== 'editor' && value !== 'viewer') throw new InvitationPersistenceError();
  return value;
};

const invitationState = (value: string): InvitationStateV1 => {
  if (
    value !== 'pending' &&
    value !== 'accepted' &&
    value !== 'revoked' &&
    value !== 'expired' &&
    value !== 'superseded'
  ) {
    throw new InvitationPersistenceError();
  }
  return value;
};

const membershipRole = (value: string): 'owner' | InvitationRoleV1 => {
  if (value !== 'owner' && value !== 'editor' && value !== 'viewer')
    throw new InvitationPersistenceError();
  return value;
};

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || result.insertId < 1) throw new InvitationPersistenceError();
  return BigInt(result.insertId);
};

const mapInvitation = (row: InvitationRow): LockedInvitation => ({
  invitationPk: databasePk(row.invitationPk),
  inviteId: row.inviteId,
  boardPk: databasePk(row.boardPk),
  boardId: row.boardId,
  boardTitle: row.boardTitle,
  ownerAccountPk: databasePk(row.ownerAccountPk),
  emailNormalized: row.emailNormalized,
  role: invitationRole(row.role),
  state: invitationState(row.state),
  tokenDigest: Buffer.from(row.tokenDigest),
  version: safeNumber(row.version),
  acceptedAccountPk: row.acceptedAccountPk === null ? null : databasePk(row.acceptedAccountPk),
  expiresAtSql: row.expiresAt,
});

const invitationSelect = `
  SELECT
    CAST(i.invitation_pk AS CHAR) AS invitationPk,
    i.public_id AS inviteId,
    CAST(i.board_pk AS CHAR) AS boardPk,
    b.public_id AS boardId,
    b.title AS boardTitle,
    CAST(b.owner_user_id AS CHAR) AS ownerAccountPk,
    i.email_normalized AS emailNormalized,
    i.role,
    i.state,
    i.token_digest AS tokenDigest,
    CAST(i.version AS CHAR) AS version,
    CAST(i.accepted_account_pk AS CHAR) AS acceptedAccountPk,
    i.expires_at AS expiresAt
  FROM board_invitations i
  JOIN boards b ON b.board_pk = i.board_pk
`;

export class InvitationPersistenceError extends Error {
  constructor() {
    super('invitation persistence integrity failure');
    this.name = 'InvitationPersistenceError';
  }
}

export class InvitationRepository {
  constructor(
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly generateUuid: () => string = generatePublicUuidV4,
  ) {}

  async searchCandidates(
    connection: PoolConnection,
    input: { normalizedQuery: string; completeEmail: string | null },
  ): Promise<MemberCandidateV1[]> {
    const [rows] = await connection.execute<CandidateRow[]>(
      `
      SELECT public_id AS accountId, email_normalized AS emailNormalized,
             display_name AS displayName
      FROM users
      WHERE status = 1 AND email_verified_at IS NOT NULL
        AND (
          LOWER(display_name) LIKE CONCAT(?, '%')
          OR (? IS NOT NULL AND email_normalized = ?)
        )
      ORDER BY LOWER(display_name), public_id
      LIMIT 40
    `,
      [input.normalizedQuery, input.completeEmail, input.completeEmail],
    );
    const candidates: Array<
      MemberCandidateV1 & {
        rank: number;
        normalizedDisplayName: string;
        normalizedEmail: string;
      }
    > = [];
    const accountIds = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      if (accountIds.has(row.accountId) || emails.has(row.emailNormalized)) continue;
      accountIds.add(row.accountId);
      emails.add(row.emailNormalized);
      candidates.push({
        kind: 'account',
        accountId: row.accountId as PrincipalId,
        displayName: row.displayName,
        rank: input.completeEmail === row.emailNormalized ? 0 : 1,
        normalizedDisplayName: row.displayName.normalize('NFKC').toLowerCase(),
        normalizedEmail: row.emailNormalized,
      });
    }
    if (input.completeEmail !== null && !emails.has(input.completeEmail)) {
      candidates.push({
        kind: 'email',
        email: input.completeEmail,
        rank: 2,
        normalizedDisplayName: '',
        normalizedEmail: input.completeEmail,
      });
    }
    candidates.sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.rank === 2)
        return left.normalizedEmail.localeCompare(right.normalizedEmail) || ''.localeCompare('');
      return (
        left.normalizedDisplayName.localeCompare(right.normalizedDisplayName) ||
        ('accountId' in left ? left.accountId : '').localeCompare(
          'accountId' in right ? right.accountId : '',
        )
      );
    });
    return candidates.slice(0, 20).map((candidate) =>
      candidate.kind === 'account'
        ? {
            kind: candidate.kind,
            accountId: candidate.accountId,
            displayName: candidate.displayName,
          }
        : { kind: candidate.kind, email: candidate.email },
    );
  }

  async lockBoardByPk(
    connection: PoolConnection,
    boardPk: bigint,
  ): Promise<LockedInvitationBoard | null> {
    const [rows] = await connection.execute<BoardRow[]>(
      `
      SELECT CAST(board_pk AS CHAR) AS boardPk, public_id AS boardId,
             CAST(owner_user_id AS CHAR) AS ownerAccountPk,
             CAST(capability_epoch AS CHAR) AS capabilityEpoch
      FROM boards
      WHERE board_pk = ? AND archived_at IS NULL
      FOR UPDATE
    `,
      [boardPk.toString()],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          boardPk: row.boardPk,
          boardId: row.boardId,
          ownerAccountPk: row.ownerAccountPk,
          capabilityEpoch: row.capabilityEpoch,
        };
  }

  async discoverByLocator(connection: PoolConnection, locator: Buffer): Promise<bigint | null> {
    const [rows] = await connection.execute<Array<RowDataPacket & { boardPk: string }>>(
      `SELECT CAST(board_pk AS CHAR) AS boardPk
       FROM board_invitations
       WHERE token_locator = ?
       LIMIT 1`,
      [locator],
    );
    return rows.length === 1 ? databasePk(rows[0]!.boardPk) : null;
  }

  async lockByLocator(
    connection: PoolConnection,
    locator: Buffer,
  ): Promise<LockedInvitation | null> {
    const [rows] = await connection.execute<InvitationRow[]>(
      `${invitationSelect}
       WHERE i.token_locator = ?
       LIMIT 1
       FOR UPDATE`,
      [locator],
    );
    return rows.length === 1 ? mapInvitation(rows[0]!) : null;
  }

  async lockByPublicId(
    connection: PoolConnection,
    boardPk: bigint,
    inviteId: string,
  ): Promise<LockedInvitation | null> {
    const [rows] = await connection.execute<InvitationRow[]>(
      `${invitationSelect}
       WHERE i.board_pk = ? AND i.public_id = ?
       LIMIT 1
       FOR UPDATE`,
      [boardPk.toString(), inviteId],
    );
    return rows.length === 1 ? mapInvitation(rows[0]!) : null;
  }

  async lockActiveIdentity(
    connection: PoolConnection,
    boardPk: bigint,
    emailNormalized: string,
  ): Promise<LockedInvitation | null> {
    const [rows] = await connection.execute<InvitationRow[]>(
      `${invitationSelect}
       WHERE i.board_pk = ? AND i.active_email_normalized = ?
       LIMIT 1
       FOR UPDATE`,
      [boardPk.toString(), emailNormalized],
    );
    return rows.length === 1 ? mapInvitation(rows[0]!) : null;
  }

  async lockVerifiedAccountByEmail(
    connection: PoolConnection,
    emailNormalized: string,
  ): Promise<LockedAccount | null> {
    const [rows] = await connection.execute<AccountRow[]>(
      `
      SELECT CAST(id AS CHAR) AS accountPk, public_id AS accountId,
             email_normalized AS emailNormalized, display_name AS displayName
      FROM users
      WHERE email_normalized = ? AND status = 1 AND email_verified_at IS NOT NULL
      LIMIT 1
      FOR UPDATE
    `,
      [emailNormalized],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          accountPk: databasePk(row.accountPk),
          accountId: row.accountId,
          emailNormalized: row.emailNormalized,
          displayName: row.displayName,
        };
  }

  async findVerifiedEmailByAccountId(
    connection: PoolConnection,
    accountId: string,
  ): Promise<string | null> {
    const [rows] = await connection.execute<Array<RowDataPacket & { emailNormalized: string }>>(
      `SELECT email_normalized AS emailNormalized
       FROM users
       WHERE public_id = ? AND status = 1 AND email_verified_at IS NOT NULL
       LIMIT 1`,
      [accountId],
    );
    return rows[0]?.emailNormalized ?? null;
  }

  async lockAccountByPk(
    connection: PoolConnection,
    accountPk: bigint,
  ): Promise<LockedAccount | null> {
    const [rows] = await connection.execute<AccountRow[]>(
      `
      SELECT CAST(id AS CHAR) AS accountPk, public_id AS accountId,
             email_normalized AS emailNormalized, display_name AS displayName
      FROM users
      WHERE id = ? AND status = 1 AND email_verified_at IS NOT NULL
      LIMIT 1
      FOR UPDATE
    `,
      [accountPk.toString()],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          accountPk: databasePk(row.accountPk),
          accountId: row.accountId,
          emailNormalized: row.emailNormalized,
          displayName: row.displayName,
        };
  }

  async lockMembershipByAccount(
    connection: PoolConnection,
    boardPk: bigint,
    accountPk: bigint,
  ): Promise<LockedManagedMembership | null> {
    return this.lockMembership(connection, boardPk, 'm.account_pk = ?', accountPk.toString());
  }

  async lockMembershipByPublicId(
    connection: PoolConnection,
    boardPk: bigint,
    memberId: string,
  ): Promise<LockedManagedMembership | null> {
    return this.lockMembership(connection, boardPk, 'm.public_id = ?', memberId);
  }

  async createInvitation(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      emailNormalized: string;
      role: InvitationRoleV1;
      locator: Buffer;
      digest: Buffer;
      inviterAccountPk: bigint;
      expiresAtSql: string;
      nowSql: string;
    },
  ): Promise<{ invitationPk: bigint; inviteId: string }> {
    const inviteId = `invite_${this.crypto.generatePublicIdV1()}`;
    const [result] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_invitations (
        public_id, board_pk, email_normalized, role, state,
        token_locator, token_digest, version, invited_by_account_pk,
        accepted_account_pk, superseded_by_invitation_pk,
        expires_at, created_at, updated_at,
        accepted_at, revoked_at, superseded_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 1, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
    `,
      [
        inviteId,
        input.boardPk.toString(),
        input.emailNormalized,
        input.role,
        input.locator,
        input.digest,
        input.inviterAccountPk.toString(),
        input.expiresAtSql,
        input.nowSql,
        input.nowSql,
      ],
    );
    return { invitationPk: insertedPk(result), inviteId };
  }

  async markExpired(
    connection: PoolConnection,
    invitationPk: bigint,
    nowSql: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_invitations
       SET state = 'expired', version = version + 1, updated_at = ?
       WHERE invitation_pk = ? AND state = 'pending'`,
      [nowSql, invitationPk.toString()],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
  }

  async supersede(
    connection: PoolConnection,
    invitationPk: bigint,
    replacementPk: bigint,
    nowSql: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_invitations
       SET state = 'superseded', version = version + 1, updated_at = ?,
           superseded_at = ?, superseded_by_invitation_pk = ?
       WHERE invitation_pk = ? AND state = 'expired'`,
      [nowSql, nowSql, replacementPk.toString(), invitationPk.toString()],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
  }

  async revoke(connection: PoolConnection, invitationPk: bigint, nowSql: string): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_invitations
       SET state = 'revoked', version = version + 1, updated_at = ?, revoked_at = ?
       WHERE invitation_pk = ? AND state = 'pending'`,
      [nowSql, nowSql, invitationPk.toString()],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
  }

  async accept(
    connection: PoolConnection,
    invitationPk: bigint,
    accountPk: bigint,
    nowSql: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_invitations
       SET state = 'accepted', version = version + 1, updated_at = ?,
           accepted_account_pk = ?, accepted_at = ?
       WHERE invitation_pk = ? AND state = 'pending'`,
      [nowSql, accountPk.toString(), nowSql, invitationPk.toString()],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
  }

  async createOrReactivateMembership(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      accountPk: bigint;
      role: InvitationRoleV1;
      nowSql: string;
    },
  ): Promise<LockedManagedMembership> {
    const memberId = `membership_${this.crypto.generatePublicIdV1()}`;
    await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_memberships (
        public_id, board_pk, account_pk, role, state, version,
        owner_account_pk, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, ?)
      ON DUPLICATE KEY UPDATE
        role = VALUES(role), state = 'active', version = version + 1,
        owner_account_pk = NULL, updated_at = VALUES(updated_at)
    `,
      [
        memberId,
        input.boardPk.toString(),
        input.accountPk.toString(),
        input.role,
        input.nowSql,
        input.nowSql,
      ],
    );
    const membership = await this.lockMembershipByAccount(
      connection,
      input.boardPk,
      input.accountPk,
    );
    if (membership === null || membership.role !== input.role || membership.state !== 'active')
      throw new InvitationPersistenceError();
    return membership;
  }

  async updateMembershipRole(
    connection: PoolConnection,
    membershipPk: bigint,
    role: InvitationRoleV1,
    expectedVersion: number,
    nowSql: string,
  ): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_memberships
       SET role = ?, version = version + 1, updated_at = ?
       WHERE membership_pk = ? AND state = 'active' AND role <> ? AND version = ?`,
      [role, nowSql, membershipPk.toString(), role, expectedVersion],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
    return expectedVersion + 1;
  }

  async removeMembership(
    connection: PoolConnection,
    membershipPk: bigint,
    expectedVersion: number,
    nowSql: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_memberships
       SET state = 'inactive', version = version + 1, updated_at = ?
       WHERE membership_pk = ? AND state = 'active' AND version = ?`,
      [nowSql, membershipPk.toString(), expectedVersion],
    );
    if (result.affectedRows !== 1) throw new InvitationPersistenceError();
  }

  async incrementEpochAndAppendInvalidation(
    connection: PoolConnection,
    input: { boardPk: bigint; boardId: string; nowSql: string },
  ): Promise<number> {
    const [epochUpdate] = await connection.execute<ResultSetHeader>(
      `UPDATE boards
       SET capability_epoch = capability_epoch + 1, updated_at = GREATEST(updated_at, ?)
       WHERE board_pk = ? AND capability_epoch < 9007199254740991`,
      [input.nowSql, input.boardPk.toString()],
    );
    if (epochUpdate.affectedRows !== 1) throw new InvitationPersistenceError();
    const [boardRows] = await connection.execute<BoardRow[]>(
      `SELECT CAST(board_pk AS CHAR) AS boardPk, public_id AS boardId,
              CAST(owner_user_id AS CHAR) AS ownerAccountPk,
              CAST(capability_epoch AS CHAR) AS capabilityEpoch
       FROM boards WHERE board_pk = ?`,
      [input.boardPk.toString()],
    );
    const epoch = safeNumber(boardRows[0]?.capabilityEpoch ?? '', true);
    const [headRows] = await connection.execute<HeadRow[]>(
      `SELECT r.revision_id AS revisionId,
              CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
       FROM board_heads h
       JOIN board_revisions r
         ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
       WHERE h.board_pk = ?
       FOR UPDATE`,
      [input.boardPk.toString()],
    );
    const head = headRows[0];
    if (head === undefined) throw new InvitationPersistenceError();
    const previousSequence = safeNumber(head.lastEventSequence, true);
    const sequence = previousSequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new InvitationPersistenceError();
    const event: BoardEventEnvelopeV1 = {
      protocolVersion: 1,
      type: 'board.event',
      boardId: input.boardId as BoardEventEnvelopeV1['boardId'],
      eventId: this.generateUuid() as BoardEventEnvelopeV1['eventId'],
      sequence,
      occurredAt: parseMysqlTimestampUtc(input.nowSql).toISOString() as TimestampV1,
      revisionId: null,
      data: {
        type: 'stream.resync.required',
        durableHeadRevisionId: formatPublicUuidV4(head.revisionId) as never,
        lastUsableSequence: previousSequence,
        reason: 'server_reset',
      },
    };
    const parsed = BoardEventEnvelopeParserV1.parse(event);
    if (!parsed.ok) throw new InvitationPersistenceError();
    const payload = Buffer.from(parsed.data.canonicalBytes);
    const [headUpdate] = await connection.execute<ResultSetHeader>(
      `UPDATE board_heads
       SET last_event_sequence = ?, updated_at = ?
       WHERE board_pk = ? AND last_event_sequence = ?`,
      [sequence, input.nowSql, input.boardPk.toString(), previousSequence],
    );
    if (headUpdate.affectedRows !== 1) throw new InvitationPersistenceError();
    const [outbox] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_event_outbox (
        event_id, board_pk, revision_pk, sequence_number, event_type,
        event_payload, event_canonical_bytes, event_sha256,
        status_code, occurred_at, delivered_at, retain_until
      ) VALUES (?, ?, NULL, ?, 'stream.resync.required', ?, ?, ?, 'P', ?, NULL, NULL)
    `,
      [
        Buffer.from(parsePublicUuidV4(event.eventId)),
        input.boardPk.toString(),
        sequence,
        payload,
        payload.byteLength,
        createHash('sha256').update(payload).digest(),
        input.nowSql,
      ],
    );
    insertedPk(outbox);
    return epoch;
  }

  async writeAudit(
    connection: PoolConnection,
    input: {
      event: AuditEventName;
      actorPublicId: string;
      userPublicId: string;
      sessionPublicId: string;
      metadata: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.audit.writeMandatory(
      { connection },
      {
        event: input.event,
        actorPublicId: input.actorPublicId,
        userPublicId: input.userPublicId,
        sessionPublicId: input.sessionPublicId,
        subjectFingerprint: null,
        metadata: input.metadata,
      },
    );
  }

  private async lockMembership(
    connection: PoolConnection,
    boardPk: bigint,
    predicate: string,
    value: string,
  ): Promise<LockedManagedMembership | null> {
    const [rows] = await connection.execute<MembershipRow[]>(
      `
      SELECT CAST(m.membership_pk AS CHAR) AS membershipPk,
             m.public_id AS memberId,
             CAST(m.account_pk AS CHAR) AS accountPk,
             u.public_id AS accountId,
             m.role, m.state, CAST(m.version AS CHAR) AS version
      FROM board_memberships m
      JOIN users u ON u.id = m.account_pk
      WHERE m.board_pk = ? AND ${predicate}
      LIMIT 1
      FOR UPDATE
    `,
      [boardPk.toString(), value],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (row.state !== 'active' && row.state !== 'inactive') throw new InvitationPersistenceError();
    return {
      membershipPk: databasePk(row.membershipPk),
      memberId: row.memberId,
      accountPk: databasePk(row.accountPk),
      accountId: row.accountId,
      role: membershipRole(row.role),
      state: row.state,
      version: safeNumber(row.version),
    };
  }
}
