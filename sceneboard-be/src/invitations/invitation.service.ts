import type {
  BoardId,
  BoardInvitationEnvelopeV1,
  InvitationAcceptanceV1,
  InvitationRoleV1,
  ManagedMembershipEnvelopeV1,
  MemberCandidateListV1,
  PrincipalId,
  TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError } from '../common/errors/app-error.js';
import { formatMysqlTimestampUtc, parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import type { InvitationMailPort } from './invitation-mail.port.js';
import {
  InvitationPersistenceError,
  InvitationRepository,
  type LockedInvitation,
} from './invitation.repository.js';
import { InvitationTokenService } from './invitation-token.service.js';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

interface ClockRow extends RowDataPacket {
  nowSql: string;
}

type OwnerCommandContext = {
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  session: SessionRecord;
  boardId: BoardId;
  ip: string;
};

type PreparedInvitation = {
  envelope: BoardInvitationEnvelopeV1;
  token: string;
  emailNormalized: string;
  boardTitle: string;
};

const normalizeSearch = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

const parseCompleteEmail = (value: string): string | null => {
  if (!/^[\x20-\x7e]+$/u.test(value) || !EMAIL_PATTERN.test(value)) return null;
  return value.toLowerCase();
};

const normalizeEmail = (value: string): string => {
  const normalized = value.normalize('NFKC').trim();
  if (
    Buffer.byteLength(normalized, 'utf8') < 5 ||
    Buffer.byteLength(normalized, 'utf8') > 254 ||
    !/^[\x20-\x7e]+$/u.test(normalized) ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return normalized.toLowerCase();
};

const safeBoardPk = (
  context: Parameters<Parameters<BoardAccessPolicy['withAuthorizedBoardTransaction']>[1]>[1],
): bigint => {
  if (context.membership == null) throw new AppError('INTERNAL_ERROR');
  return context.membership.boardPk;
};

const databaseNow = async (connection: PoolConnection): Promise<string> => {
  const [rows] = await connection.execute<ClockRow[]>('SELECT UTC_TIMESTAMP(3) AS nowSql');
  const nowSql = rows[0]?.nowSql;
  if (nowSql === undefined) throw new InvitationPersistenceError();
  parseMysqlTimestampUtc(nowSql);
  return nowSql;
};

const envelope = (
  inviteId: string,
  role: InvitationRoleV1,
  expiresAtSql: string,
): BoardInvitationEnvelopeV1 => ({
  invitation: {
    inviteId,
    role,
    expiresAt: parseMysqlTimestampUtc(expiresAtSql).toISOString() as TimestampV1,
    state: 'pending',
  },
});

const isExpired = (invitation: LockedInvitation, nowSql: string): boolean =>
  parseMysqlTimestampUtc(invitation.expiresAtSql).valueOf() <=
  parseMysqlTimestampUtc(nowSql).valueOf();

const publicActor = (context: OwnerCommandContext): string => context.principal.actor.principalId;

export class InvitationService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly mysql: MysqlService,
    private readonly invitations: InvitationRepository,
    private readonly tokens: InvitationTokenService,
    private readonly mailer: InvitationMailPort,
    private readonly rateLimits: RateLimitService,
  ) {}

  async searchCandidates(
    input: OwnerCommandContext & { query: string },
  ): Promise<MemberCandidateListV1> {
    const normalizedQuery = normalizeSearch(input.query);
    if ([...normalizedQuery].length < 3) throw new AppError('INVALID_PAYLOAD');
    await this.limitOwnerBoard('member-search', input);
    await this.limitIp('member-search-ip', input.ip, 60);
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'membership.list',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection) => ({
        candidates: await this.invitations.searchCandidates(connection, {
          normalizedQuery,
          completeEmail: parseCompleteEmail(normalizedQuery),
        }),
      }),
    );
  }

  async issue(
    input: OwnerCommandContext & {
      email?: string | undefined;
      accountId?: string | undefined;
      role: InvitationRoleV1;
    },
  ): Promise<BoardInvitationEnvelopeV1> {
    if ((input.email === undefined) === (input.accountId === undefined))
      throw new AppError('INVALID_PAYLOAD');
    const directEmail = input.email === undefined ? null : normalizeEmail(input.email);
    await this.limitOwnerBoard('invitation-issue', input);
    const prepared = await this.ownerInvitationTransaction(input, async (connection, boardPk) => {
      const nowSql = await databaseNow(connection);
      const emailNormalized =
        directEmail ??
        (await this.invitations.findVerifiedEmailByAccountId(connection, input.accountId!));
      if (emailNormalized === null) throw new AppError('INVITATION_NOT_FOUND');
      const active = await this.invitations.lockActiveIdentity(
        connection,
        boardPk,
        emailNormalized,
      );
      if (active !== null) {
        if (isExpired(active, nowSql))
          await this.invitations.markExpired(connection, active.invitationPk, nowSql);
        else throw new AppError('INVITATION_CONFLICT');
      }
      const account = await this.invitations.lockVerifiedAccountByEmail(
        connection,
        emailNormalized,
      );
      if (input.accountId !== undefined && account?.accountId !== input.accountId)
        throw new AppError('INVITATION_NOT_FOUND');
      if (account !== null && account.accountPk === input.principal.userPk) {
        throw new AppError('INVITATION_CONFLICT');
      }
      const issued = this.tokens.issue();
      const expiresAtSql = formatMysqlTimestampUtc(
        new Date(parseMysqlTimestampUtc(nowSql).valueOf() + INVITATION_LIFETIME_MS),
      );
      const created = await this.invitations.createInvitation(connection, {
        boardPk,
        emailNormalized,
        role: input.role,
        locator: issued.locator,
        digest: issued.digest,
        inviterAccountPk: input.principal.userPk,
        expiresAtSql,
        nowSql,
      });
      const invitation = await this.invitations.lockByPublicId(
        connection,
        boardPk,
        created.inviteId,
      );
      if (invitation === null) throw new InvitationPersistenceError();
      await this.invitations.writeAudit(connection, {
        event: 'invitation.issued',
        actorPublicId: publicActor(input),
        userPublicId: input.session.user.publicId,
        sessionPublicId: input.session.publicId,
        metadata: {
          boardPk: boardPk.toString(),
          invitationPk: created.invitationPk.toString(),
          role: input.role,
        },
      });
      return {
        envelope: envelope(created.inviteId, input.role, expiresAtSql),
        token: issued.token,
        emailNormalized,
        boardTitle: invitation.boardTitle,
      };
    });
    await this.send(prepared);
    return prepared.envelope;
  }

  async resend(
    input: OwnerCommandContext & { inviteId: string },
  ): Promise<BoardInvitationEnvelopeV1> {
    await this.limitOwnerBoard('invitation-resend', input);
    const outcome = await this.ownerInvitationTransaction<PreparedInvitation | { conflict: true }>(
      input,
      async (connection, boardPk) => {
        const nowSql = await databaseNow(connection);
        const prior = await this.invitations.lockByPublicId(connection, boardPk, input.inviteId);
        if (prior === null) throw new AppError('INVITATION_NOT_FOUND');
        if (prior.state !== 'pending' || isExpired(prior, nowSql)) {
          if (prior.state === 'pending') {
            await this.invitations.markExpired(connection, prior.invitationPk, nowSql);
            return { conflict: true };
          }
          throw new AppError('INVITATION_CONFLICT');
        }
        await this.invitations.markExpired(connection, prior.invitationPk, nowSql);
        const issued = this.tokens.issue();
        const expiresAtSql = formatMysqlTimestampUtc(
          new Date(parseMysqlTimestampUtc(nowSql).valueOf() + INVITATION_LIFETIME_MS),
        );
        const created = await this.invitations.createInvitation(connection, {
          boardPk,
          emailNormalized: prior.emailNormalized,
          role: prior.role,
          locator: issued.locator,
          digest: issued.digest,
          inviterAccountPk: input.principal.userPk,
          expiresAtSql,
          nowSql,
        });
        await this.invitations.supersede(
          connection,
          prior.invitationPk,
          created.invitationPk,
          nowSql,
        );
        await this.invitations.writeAudit(connection, {
          event: 'invitation.resent',
          actorPublicId: publicActor(input),
          userPublicId: input.session.user.publicId,
          sessionPublicId: input.session.publicId,
          metadata: {
            boardPk: boardPk.toString(),
            invitationPk: created.invitationPk.toString(),
            role: prior.role,
          },
        });
        return {
          envelope: envelope(created.inviteId, prior.role, expiresAtSql),
          token: issued.token,
          emailNormalized: prior.emailNormalized,
          boardTitle: prior.boardTitle,
        };
      },
    );
    if (!('envelope' in outcome)) throw new AppError('INVITATION_CONFLICT');
    const prepared = outcome;
    await this.send(prepared);
    return prepared.envelope;
  }

  async revoke(input: OwnerCommandContext & { inviteId: string }): Promise<void> {
    await this.limitOwnerBoard('invitation-revoke', input);
    const revoked = await this.ownerInvitationTransaction(input, async (connection, boardPk) => {
      const nowSql = await databaseNow(connection);
      const invitation = await this.invitations.lockByPublicId(connection, boardPk, input.inviteId);
      if (invitation === null) throw new AppError('INVITATION_NOT_FOUND');
      if (invitation.state === 'revoked') return true;
      if (invitation.state !== 'pending' || isExpired(invitation, nowSql)) {
        if (invitation.state === 'pending') {
          await this.invitations.markExpired(connection, invitation.invitationPk, nowSql);
          return false;
        }
        throw new AppError('INVITATION_CONFLICT');
      }
      await this.invitations.revoke(connection, invitation.invitationPk, nowSql);
      await this.invitations.writeAudit(connection, {
        event: 'invitation.revoked',
        actorPublicId: publicActor(input),
        userPublicId: input.session.user.publicId,
        sessionPublicId: input.session.publicId,
        metadata: {
          boardPk: boardPk.toString(),
          invitationPk: invitation.invitationPk.toString(),
        },
      });
      return true;
    });
    if (!revoked) throw new AppError('INVITATION_CONFLICT');
  }

  async accept(input: {
    token: string;
    session: SessionRecord;
    ip: string;
  }): Promise<InvitationAcceptanceV1> {
    await this.rateLimits.consume({
      surface: 'invitation-accept',
      purpose: 'rate-limit-user/v1',
      identity: input.session.user.publicId,
      limit: 30,
      windowMs: 60_000,
    });
    await this.limitIp('invitation-accept-ip', input.ip, 60);
    const parsed = this.tokens.parseAndDigest(input.token);
    const boardPk = await this.mysql.withConnection((connection) =>
      this.invitations.discoverByLocator(connection, parsed.locator),
    );
    if (boardPk === null) throw new AppError('INVITATION_NOT_FOUND');
    const outcome = await this.mysql.withConnection((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const board = await this.invitations.lockBoardByPk(connection, boardPk);
        if (board === null) throw new AppError('INVITATION_NOT_FOUND');
        const nowSql = await databaseNow(connection);
        const invitation = await this.invitations.lockByLocator(connection, parsed.locator);
        if (
          invitation === null ||
          invitation.boardPk !== boardPk ||
          !this.tokens.verify(input.token, invitation.tokenDigest)
        ) {
          throw new AppError('INVITATION_NOT_FOUND');
        }
        const account = await this.invitations.lockAccountByPk(
          connection,
          BigInt(input.session.user.databaseId),
        );
        if (
          account === null ||
          account.emailNormalized !== invitation.emailNormalized ||
          input.session.user.email.toLowerCase() !== invitation.emailNormalized
        ) {
          throw new AppError('INVITATION_NOT_FOUND');
        }
        if (invitation.state === 'accepted') {
          if (invitation.acceptedAccountPk !== account.accountPk)
            throw new AppError('INVITATION_NOT_FOUND');
          const replayMembership = await this.invitations.lockMembershipByAccount(
            connection,
            boardPk,
            account.accountPk,
          );
          if (replayMembership === null || replayMembership.role === 'owner')
            throw new AppError('INVITATION_NOT_FOUND');
          return {
            membership: {
              boardId: board.boardId as BoardId,
              accountId: account.accountId as PrincipalId,
              role: replayMembership.role,
              version: replayMembership.version,
            },
            replayed: true,
          };
        }
        if (invitation.state !== 'pending') throw new AppError('INVITATION_GONE');
        if (isExpired(invitation, nowSql)) {
          await this.invitations.markExpired(connection, invitation.invitationPk, nowSql);
          return { gone: true } as const;
        }
        if (account.accountPk === BigInt(board.ownerAccountPk))
          throw new AppError('MEMBERSHIP_CONFLICT');
        const existing = await this.invitations.lockMembershipByAccount(
          connection,
          boardPk,
          account.accountPk,
        );
        if (existing !== null && existing.state === 'active' && existing.role !== invitation.role) {
          throw new AppError('MEMBERSHIP_CONFLICT');
        }
        const membership =
          existing !== null && existing.state === 'active'
            ? existing
            : await this.invitations.createOrReactivateMembership(connection, {
                boardPk,
                accountPk: account.accountPk,
                role: invitation.role,
                nowSql,
              });
        await this.invitations.accept(
          connection,
          invitation.invitationPk,
          account.accountPk,
          nowSql,
        );
        await this.invitations.incrementEpochAndAppendInvalidation(connection, {
          boardPk,
          boardId: board.boardId,
          nowSql,
        });
        await this.invitations.writeAudit(connection, {
          event: 'invitation.accepted',
          actorPublicId: input.session.user.publicId,
          userPublicId: input.session.user.publicId,
          sessionPublicId: input.session.publicId,
          metadata: {
            boardPk: boardPk.toString(),
            invitationPk: invitation.invitationPk.toString(),
            role: invitation.role,
            replayed: false,
          },
        });
        return {
          membership: {
            boardId: board.boardId as BoardId,
            accountId: account.accountId as PrincipalId,
            role: invitation.role,
            version: membership.version,
          },
          replayed: false,
        };
      }),
    );
    if ('gone' in outcome) throw new AppError('INVITATION_GONE');
    return outcome;
  }

  async updateMember(
    input: OwnerCommandContext & {
      memberId: string;
      role: InvitationRoleV1;
      version: number;
    },
  ): Promise<ManagedMembershipEnvelopeV1> {
    await this.limitOwnerBoard('membership-update', input);
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'membership.role.update',
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const boardPk = safeBoardPk(context);
        const membership = await this.invitations.lockMembershipByPublicId(
          connection,
          boardPk,
          input.memberId,
        );
        if (membership === null || membership.state !== 'active')
          throw new AppError('INVITATION_NOT_FOUND');
        if (
          membership.role === 'owner' ||
          membership.accountPk === input.principal.userPk ||
          membership.version !== input.version
        ) {
          throw new AppError('MEMBERSHIP_CONFLICT');
        }
        if (membership.role === input.role) {
          return {
            membership: {
              accountId: membership.accountId as PrincipalId,
              role: input.role,
              version: membership.version,
            },
            capabilityEpoch: context.membership!.capabilityEpoch,
          };
        }
        const nowSql = await databaseNow(connection);
        const nextVersion = await this.invitations.updateMembershipRole(
          connection,
          membership.membershipPk,
          input.role,
          input.version,
          nowSql,
        );
        const capabilityEpoch = await this.invitations.incrementEpochAndAppendInvalidation(
          connection,
          { boardPk, boardId: input.boardId, nowSql },
        );
        await this.invitations.writeAudit(connection, {
          event: 'membership.role.updated',
          actorPublicId: publicActor(input),
          userPublicId: input.session.user.publicId,
          sessionPublicId: input.session.publicId,
          metadata: {
            boardPk: boardPk.toString(),
            membershipPk: membership.membershipPk.toString(),
            role: input.role,
            capabilityEpoch,
          },
        });
        return {
          membership: {
            accountId: membership.accountId as PrincipalId,
            role: input.role,
            version: nextVersion,
          },
          capabilityEpoch,
        };
      },
    );
  }

  async removeMember(
    input: OwnerCommandContext & { memberId: string; version: number },
  ): Promise<void> {
    await this.limitOwnerBoard('membership-remove', input);
    await this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'membership.remove',
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const boardPk = safeBoardPk(context);
        const membership = await this.invitations.lockMembershipByPublicId(
          connection,
          boardPk,
          input.memberId,
        );
        if (membership === null || membership.state !== 'active')
          throw new AppError('INVITATION_NOT_FOUND');
        if (
          membership.role === 'owner' ||
          membership.accountPk === input.principal.userPk ||
          membership.version !== input.version
        ) {
          throw new AppError('MEMBERSHIP_CONFLICT');
        }
        const nowSql = await databaseNow(connection);
        await this.invitations.removeMembership(
          connection,
          membership.membershipPk,
          input.version,
          nowSql,
        );
        const capabilityEpoch = await this.invitations.incrementEpochAndAppendInvalidation(
          connection,
          { boardPk, boardId: input.boardId, nowSql },
        );
        await this.invitations.writeAudit(connection, {
          event: 'membership.removed',
          actorPublicId: publicActor(input),
          userPublicId: input.session.user.publicId,
          sessionPublicId: input.session.publicId,
          metadata: {
            boardPk: boardPk.toString(),
            membershipPk: membership.membershipPk.toString(),
            capabilityEpoch,
          },
        });
      },
    );
  }

  private async ownerInvitationTransaction<Value>(
    input: OwnerCommandContext,
    apply: (connection: PoolConnection, boardPk: bigint) => Promise<Value>,
  ): Promise<Value> {
    try {
      return await this.accessPolicy.withAuthorizedBoardTransaction(
        {
          principal: input.principal,
          operation: 'membership.invite',
          boardId: input.boardId,
          isolation: 'READ_COMMITTED_WRITE',
        },
        (connection, context) => apply(connection, safeBoardPk(context)),
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        ('code' in error || 'errno' in error) &&
        ((error as { code?: unknown }).code === 'ER_DUP_ENTRY' ||
          (error as { errno?: unknown }).errno === 1062)
      ) {
        throw new AppError('INVITATION_CONFLICT');
      }
      throw error;
    }
  }

  private async limitOwnerBoard(surface: string, input: OwnerCommandContext): Promise<void> {
    await this.rateLimits.consume({
      surface,
      purpose: 'rate-limit-user/v1',
      identity: `${input.session.user.publicId}\0${input.boardId}`,
      limit: 30,
      windowMs: 60_000,
    });
  }

  private async limitIp(surface: string, ip: string, limit: number): Promise<void> {
    await this.rateLimits.consume({
      surface,
      purpose: 'rate-limit-ip/v1',
      identity: ip,
      limit,
      windowMs: 60_000,
    });
  }

  private async send(input: PreparedInvitation): Promise<void> {
    await this.mailer.sendInvitation({
      to: input.emailNormalized,
      boardTitle: input.boardTitle,
      role: input.envelope.invitation.role,
      token: input.token,
    });
  }
}
