import type {
  BoardAuthorizationOperationTypeV1,
  BoardAuthorizationSurfaceV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { membershipPolicyFor } from './membership-capability.matrix.js';
import type { MembershipAuthorizationContextV1 } from './membership-authorization.context.js';
import { MembershipRepository, MembershipRowIntegrityError } from './membership.repository.js';

export class MembershipAuthorizationDeniedError extends Error {
  constructor() {
    super('board membership authorization denied');
    this.name = 'MembershipAuthorizationDeniedError';
  }
}

export class MembershipAuthorizationInvariantError extends Error {
  constructor() {
    super('board membership authorization invariant failed');
    this.name = 'MembershipAuthorizationInvariantError';
  }
}

export class BoardMembershipAuthorizationService {
  constructor(private readonly memberships: MembershipRepository) {}

  async createOwnerMembership(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      ownerAccountPk: bigint;
      createdAtSql: string;
    },
  ): Promise<void> {
    await this.memberships.createOwner(connection, input);
  }

  async authorize(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      canonicalOwnerAccountPk: bigint;
      accountPk: bigint;
      operation: string;
      surface: BoardAuthorizationSurfaceV1;
      write: boolean;
    },
  ): Promise<MembershipAuthorizationContextV1> {
    const policy = membershipPolicyFor(input.operation, input.surface);
    if (policy === null || policy.operation === 'board.create')
      throw new MembershipAuthorizationDeniedError();
    let membership = await this.memberships.findActive(connection, {
      boardPk: input.boardPk,
      accountPk: input.accountPk,
      lock: input.write,
    });
    if (membership === null && input.accountPk === input.canonicalOwnerAccountPk) {
      await this.memberships.adoptCanonicalOwner(connection, {
        boardPk: input.boardPk,
        ownerAccountPk: input.accountPk,
      });
      membership = await this.memberships.findActive(connection, {
        boardPk: input.boardPk,
        accountPk: input.accountPk,
        lock: input.write,
      });
    }
    if (membership === null || policy.roles[membership.role] !== true)
      throw new MembershipAuthorizationDeniedError();
    if (
      (membership.role === 'owner') !==
      (membership.accountPk === input.canonicalOwnerAccountPk)
    ) {
      throw new MembershipAuthorizationInvariantError();
    }
    return Object.freeze({
      boardPk: membership.boardPk,
      accountPk: membership.accountPk,
      membershipPk: membership.membershipPk,
      membershipRole: membership.role,
      membershipVersion: membership.version,
      operation: policy.operation as BoardAuthorizationOperationTypeV1,
      surface: input.surface,
      write: input.write,
    });
  }

  async recheck(
    connection: PoolConnection,
    context: MembershipAuthorizationContextV1,
  ): Promise<void> {
    if (!context.write) return;
    let membership;
    try {
      membership = await this.memberships.findActive(connection, {
        boardPk: context.boardPk,
        accountPk: context.accountPk,
        lock: true,
      });
    } catch (error) {
      if (error instanceof MembershipRowIntegrityError)
        throw new MembershipAuthorizationInvariantError();
      throw error;
    }
    const policy = membershipPolicyFor(context.operation, context.surface);
    if (
      membership === null ||
      policy === null ||
      policy.roles[membership.role] !== true ||
      membership.membershipPk !== context.membershipPk ||
      membership.version !== context.membershipVersion ||
      membership.role !== context.membershipRole
    ) {
      throw new MembershipAuthorizationDeniedError();
    }
  }
}
