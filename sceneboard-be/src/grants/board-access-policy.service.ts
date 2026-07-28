import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BoardIdParserV1,
  type ArtifactRequestCapabilityV1,
  type BoardErrorV1,
  type BoardId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import type { MembershipAuthorizationContextV1 } from '../memberships/membership-authorization.context.js';
import { MembershipRowIntegrityError } from '../memberships/membership.repository.js';
import {
  BoardMembershipAuthorizationService,
  MembershipAuthorizationDeniedError,
  MembershipAuthorizationInvariantError,
} from '../memberships/membership.service.js';
import {
  authorizationRuleFor,
  isBoardAccessOperation,
  type AuthorizedBoardContextV1,
  type AuthorizedBoardTransactionInputV1,
  type BoardAccessPolicy,
  type CreateBoardBindingCapabilityV1,
  type CurrentArtifactCapabilityPolicyV1,
  type ResolvedBoardPrincipalV1,
} from './board-access.policy.js';
import { lifecycleValuesFromMask, scopeValuesFromMask } from './scope-map.js';

interface ClockRow extends RowDataPacket {
  transactionNow: string;
}

interface UserRow extends RowDataPacket {
  userPk: string;
  publicId: string;
  status: number;
}

interface SessionRow extends RowDataPacket {
  sessionPk: string;
  userPk: string;
  familyPublicId: string;
  status: number;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

interface GrantRow extends RowDataPacket {
  grantPk: string;
  publicId: string;
  ownerUserPk: string;
  sourceSessionPk: string | null;
  scopeMask: number;
  lifecycleMask: number;
  lifetime: number;
  status: number;
  expiresAt: string;
}

interface CredentialRow extends RowDataPacket {
  credentialPk: string;
  grantPk: string;
  status: number;
}

interface BindingRow extends RowDataPacket {
  grantPk: string;
}

interface BoardAuthorizationRow extends RowDataPacket {
  boardPk: string;
  ownerUserPk: string;
  archivedAt: string | null;
  capabilityEpoch?: string;
}

interface PolicyEpochRow extends RowDataPacket {
  ownerUserPk: string;
  policyEpoch: Buffer;
}

interface PolicyCapabilityRow extends RowDataPacket {
  capability: string;
}

interface BoardAccessPolicyRuntime {
  retryJitter: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DENY_UNTARGETED_POLICY: CurrentArtifactCapabilityPolicyV1 = Object.freeze({
  allowedArtifactRequestCapabilities: Object.freeze([]),
  policyEpoch: Buffer.alloc(16).toString('base64url'),
});

const BOARD_ERROR_DEFINITIONS = {
  UNAUTHENTICATED: {
    message: 'Authentication is required',
    category: 'auth',
    retryable: false,
    httpStatusHint: 401,
    details: null,
  },
  FORBIDDEN: {
    message: 'Forbidden',
    category: 'auth',
    retryable: false,
    httpStatusHint: 403,
    details: null,
  },
  BOARD_NOT_FOUND: {
    message: 'Board not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: null,
  },
  SERVICE_UNAVAILABLE: {
    message: 'Service unavailable',
    category: 'availability',
    retryable: true,
    httpStatusHint: 503,
    details: { retryAfterSeconds: null },
  },
  INTERNAL_ERROR: {
    message: 'Internal server error',
    category: 'internal',
    retryable: false,
    httpStatusHint: 500,
    details: null,
  },
} as const satisfies Partial<
  Record<BoardErrorV1['code'], Omit<BoardErrorV1, 'protocolVersion' | 'type' | 'code'>>
>;

const boardFailure = (code: keyof typeof BOARD_ERROR_DEFINITIONS): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code,
    ...BOARD_ERROR_DEFINITIONS[code],
  } as BoardErrorV1);

const archivedBoardFailure = (boardId: BoardId, archivedAt: string): BoardContractError => {
  let timestamp: TimestampV1;
  try {
    timestamp = parseMysqlTimestampUtc(archivedAt).toISOString() as TimestampV1;
  } catch {
    throw boardFailure('INTERNAL_ERROR');
  }
  return new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_ALREADY_ARCHIVED',
    message: 'Board is already archived',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: { boardId, archivedAt: timestamp },
  });
};

const parseDatabasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw boardFailure('INTERNAL_ERROR');
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw boardFailure('INTERNAL_ERROR');
  return parsed;
};

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
};

const isCurrentSession = (row: SessionRow, transactionNow: Date): boolean =>
  row.status === 1 &&
  parseMysqlTimestampUtc(row.idleExpiresAt).valueOf() > transactionNow.valueOf() &&
  parseMysqlTimestampUtc(row.absoluteExpiresAt).valueOf() > transactionNow.valueOf();

const isRetryableTransactionError = (error: unknown): boolean => {
  if (error instanceof BoardContractError) return false;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return (
    candidate.errno === 1205 ||
    candidate.errno === 1213 ||
    candidate.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    candidate.code === 'ER_LOCK_DEADLOCK'
  );
};

const validateBoardId = (value: BoardId | null): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw boardFailure('FORBIDDEN');
  return parsed.data.value;
};

const assertPrincipalShape = (principal: ResolvedBoardPrincipalV1): void => {
  if (principal.kind === 'user') {
    if (principal.actor.principalKind !== 'user' || principal.actor.grantId !== null)
      throw boardFailure('FORBIDDEN');
    return;
  }
  if (principal.kind === 'mcp') {
    if (
      principal.actor.principalKind !== 'mcp_client' ||
      principal.actor.grantId !== principal.grantId
    ) {
      throw boardFailure('FORBIDDEN');
    }
    return;
  }
  throw boardFailure('FORBIDDEN');
};

export class MysqlBoardAccessPolicy implements BoardAccessPolicy {
  private readonly runtime: BoardAccessPolicyRuntime;

  constructor(
    private readonly mysql: MysqlService,
    private readonly crypto: CryptoService,
    runtime: Partial<BoardAccessPolicyRuntime> = {},
    private readonly membershipAuthorization: BoardMembershipAuthorizationService | null = null,
  ) {
    this.runtime = {
      retryJitter: runtime.retryJitter ?? (() => Math.floor(Math.random() * 26)),
      sleep:
        runtime.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
  }

  async withAuthorizedBoardTransaction<T>(
    input: AuthorizedBoardTransactionInputV1,
    apply: (connection: PoolConnection, context: AuthorizedBoardContextV1) => Promise<T>,
  ): Promise<T> {
    const boardId = this.validateDispatch(input);
    const retryDelays = [25, 75, 175] as const;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return await this.mysql.withConnection((connection) =>
          withTransaction(
            connection,
            input.isolation === 'READ_COMMITTED_WRITE' ? 'READ COMMITTED' : 'REPEATABLE READ',
            async () => this.authorizeAndApply(connection, input, boardId, apply),
          ),
        );
      } catch (error) {
        const delay = retryDelays[attempt];
        if (delay === undefined || !isRetryableTransactionError(error)) throw error;
        const jitter = this.runtime.retryJitter();
        if (!Number.isInteger(jitter) || jitter < 0 || jitter > 25)
          throw boardFailure('INTERNAL_ERROR');
        await this.runtime.sleep(delay + jitter);
      }
    }
    throw boardFailure('SERVICE_UNAVAILABLE');
  }

  private validateDispatch(input: AuthorizedBoardTransactionInputV1): BoardId | null {
    if (!isBoardAccessOperation(input.operation)) throw boardFailure('FORBIDDEN');
    const rule = authorizationRuleFor(input.operation);
    if (rule === undefined || rule.isolation !== input.isolation) throw boardFailure('FORBIDDEN');
    assertPrincipalShape(input.principal);
    if (rule.target === 'null') {
      if (input.boardId !== null) throw boardFailure('FORBIDDEN');
      return null;
    }
    if (input.boardId === null) throw boardFailure('FORBIDDEN');
    return validateBoardId(input.boardId);
  }

  private async authorizeAndApply<T>(
    connection: PoolConnection,
    input: AuthorizedBoardTransactionInputV1,
    boardId: BoardId | null,
    apply: (connection: PoolConnection, context: AuthorizedBoardContextV1) => Promise<T>,
  ): Promise<T> {
    const transactionNowSql = await this.readTransactionClock(connection);
    const transactionNow = parseMysqlTimestampUtc(transactionNowSql);
    let context: AuthorizedBoardContextV1;
    if (input.principal.kind === 'user') {
      context = await this.authorizeUser(
        connection,
        input,
        input.principal,
        boardId,
        transactionNow,
        transactionNowSql,
      );
    } else {
      context = await this.authorizeMcp(
        connection,
        input,
        input.principal,
        boardId,
        transactionNow,
        transactionNowSql,
      );
    }
    let callbackActive = true;
    const guardedContext: AuthorizedBoardContextV1 = {
      ...context,
      createBinding:
        context.createBinding === null
          ? null
          : {
              ...context.createBinding,
              bindCreatedBoard: async (createdBoardId: BoardId) => {
                if (!callbackActive) throw boardFailure('INTERNAL_ERROR');
                return context.createBinding!.bindCreatedBoard(createdBoardId);
              },
            },
      createOwnerMembership:
        context.createOwnerMembership == null
          ? null
          : {
              create: async (boardPk, createdAtSql) => {
                if (!callbackActive) throw boardFailure('INTERNAL_ERROR');
                return context.createOwnerMembership!.create(boardPk, createdAtSql);
              },
            },
    };
    try {
      const result = await apply(connection, guardedContext);
      if (guardedContext.membership != null) {
        try {
          await this.membershipAuthorization?.recheck(connection, guardedContext.membership);
        } catch (error) {
          if (error instanceof MembershipAuthorizationDeniedError)
            throw boardFailure('BOARD_NOT_FOUND');
          if (error instanceof MembershipAuthorizationInvariantError)
            throw boardFailure('INTERNAL_ERROR');
          if (error instanceof MembershipRowIntegrityError) throw boardFailure('INTERNAL_ERROR');
          throw error;
        }
      }
      return result;
    } finally {
      callbackActive = false;
    }
  }

  private async readTransactionClock(connection: PoolConnection): Promise<string> {
    const [rows] = await connection.execute<ClockRow[]>(
      'SELECT UTC_TIMESTAMP(3) AS transactionNow',
    );
    const value = rows[0]?.transactionNow;
    if (value === undefined) throw boardFailure('INTERNAL_ERROR');
    parseMysqlTimestampUtc(value);
    return value;
  }

  private async lockUser(connection: PoolConnection, userPk: bigint): Promise<UserRow> {
    const [rows] = await connection.execute<UserRow[]>(
      `
      SELECT CAST(id AS CHAR) AS userPk, public_id AS publicId, status
      FROM users
      WHERE id = ?
      FOR UPDATE
    `,
      [userPk.toString()],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      parseDatabasePk(row.userPk) !== userPk ||
      row.status !== 1
    ) {
      throw boardFailure('UNAUTHENTICATED');
    }
    return row;
  }

  private async lockFamily(
    connection: PoolConnection,
    ownerUserPk: bigint,
    familyPublicId: string,
  ): Promise<SessionRow[]> {
    const [rows] = await connection.execute<SessionRow[]>(
      `
      SELECT
        CAST(id AS CHAR) AS sessionPk,
        CAST(user_id AS CHAR) AS userPk,
        family_public_id AS familyPublicId,
        status,
        idle_expires_at AS idleExpiresAt,
        absolute_expires_at AS absoluteExpiresAt
      FROM auth_sessions
      WHERE user_id = ? AND family_public_id = ?
      ORDER BY id ASC
      FOR UPDATE
    `,
      [ownerUserPk.toString(), familyPublicId],
    );
    for (const row of rows) {
      if (parseDatabasePk(row.userPk) !== ownerUserPk || row.familyPublicId !== familyPublicId) {
        throw boardFailure('INTERNAL_ERROR');
      }
    }
    return rows;
  }

  private async authorizeUser(
    connection: PoolConnection,
    input: AuthorizedBoardTransactionInputV1,
    principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>,
    boardId: BoardId | null,
    transactionNow: Date,
    transactionNowSql: string,
  ): Promise<AuthorizedBoardContextV1> {
    const user = await this.lockUser(connection, principal.userPk);
    if (user.publicId !== principal.actor.principalId) throw boardFailure('UNAUTHENTICATED');
    const family = await this.lockFamily(connection, principal.userPk, principal.familyPublicId);
    const current = family.find((row) => parseDatabasePk(row.sessionPk) === principal.sessionPk);
    if (current === undefined || !isCurrentSession(current, transactionNow))
      throw boardFailure('UNAUTHENTICATED');
    const board = await this.authorizeBoardTarget(
      connection,
      input,
      boardId,
      principal.userPk,
      null,
    );
    const policy =
      board === null
        ? DEFAULT_DENY_UNTARGETED_POLICY
        : await this.readArtifactPolicy(connection, board, board.ownerUserPk, transactionNowSql);
    return {
      actor: principal.actor,
      ownerUserPk: board?.ownerUserPk ?? principal.userPk,
      accountUserPk: principal.userPk,
      access: { kind: 'owner', ownerUserPk: principal.userPk },
      createBinding: null,
      createOwnerMembership:
        input.operation === 'board.create' && this.membershipAuthorization !== null
          ? {
              create: (boardPk, createdAtSql) =>
                this.membershipAuthorization!.createOwnerMembership(connection, {
                  boardPk,
                  ownerAccountPk: principal.userPk,
                  createdAtSql,
                }),
            }
          : null,
      membership: board?.membership ?? null,
      artifactCapabilityPolicy: policy,
    };
  }

  private async authorizeMcp(
    connection: PoolConnection,
    input: AuthorizedBoardTransactionInputV1,
    principal: Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }>,
    boardId: BoardId | null,
    transactionNow: Date,
    transactionNowSql: string,
  ): Promise<AuthorizedBoardContextV1> {
    await this.lockUser(connection, principal.ownerUserPk);
    const family =
      principal.sourceFamilyPublicId === null
        ? []
        : await this.lockFamily(connection, principal.ownerUserPk, principal.sourceFamilyPublicId);
    const [grantRows] = await connection.execute<GrantRow[]>(
      `
      SELECT
        CAST(id AS CHAR) AS grantPk,
        public_id AS publicId,
        CAST(owner_user_id AS CHAR) AS ownerUserPk,
        CAST(source_session_id AS CHAR) AS sourceSessionPk,
        scope_mask AS scopeMask,
        lifecycle_mask AS lifecycleMask,
        lifetime,
        status,
        expires_at AS expiresAt
      FROM mcp_grants
      WHERE id = ?
      FOR UPDATE
    `,
      [principal.grantPk.toString()],
    );
    const grant = grantRows[0];
    if (
      grantRows.length !== 1 ||
      grant === undefined ||
      parseDatabasePk(grant.grantPk) !== principal.grantPk ||
      parseDatabasePk(grant.ownerUserPk) !== principal.ownerUserPk ||
      grant.publicId !== principal.grantId ||
      grant.status !== 2 ||
      parseMysqlTimestampUtc(grant.expiresAt).valueOf() <= transactionNow.valueOf()
    ) {
      throw boardFailure('UNAUTHENTICATED');
    }
    const scopes = scopeValuesFromMask(grant.scopeMask);
    if (!sameStringSet(scopes, principal.actor.scopes)) throw boardFailure('UNAUTHENTICATED');
    const rule = authorizationRuleFor(input.operation);
    if (!rule.requiredCapabilities.every((capability) => scopes.includes(capability)))
      throw this.authorizationDenied(boardId);
    const lifecycle = lifecycleValuesFromMask(grant.lifecycleMask);
    if (
      rule.requiredLifecyclePermission !== null &&
      !lifecycle.includes(rule.requiredLifecyclePermission)
    ) {
      throw this.authorizationDenied(boardId);
    }
    if (grant.lifetime === 1) {
      if (principal.sourceFamilyPublicId === null || grant.sourceSessionPk === null) {
        throw boardFailure('UNAUTHENTICATED');
      }
      const sourceSessionPk = parseDatabasePk(grant.sourceSessionPk);
      if (
        !family.some(
          (row) =>
            parseDatabasePk(row.sessionPk) === sourceSessionPk &&
            isCurrentSession(row, transactionNow),
        )
      ) {
        throw boardFailure('UNAUTHENTICATED');
      }
    } else if (
      grant.lifetime !== 2 ||
      principal.sourceFamilyPublicId !== null ||
      grant.sourceSessionPk !== null
    ) {
      throw boardFailure('UNAUTHENTICATED');
    }
    const [credentialRows] = await connection.execute<CredentialRow[]>(
      `
      SELECT CAST(id AS CHAR) AS credentialPk, CAST(grant_id AS CHAR) AS grantPk, status
      FROM mcp_grant_credentials
      WHERE id = ?
      FOR UPDATE
    `,
      [principal.credentialPk.toString()],
    );
    const credential = credentialRows[0];
    if (
      credentialRows.length !== 1 ||
      credential === undefined ||
      parseDatabasePk(credential.credentialPk) !== principal.credentialPk ||
      parseDatabasePk(credential.grantPk) !== principal.grantPk ||
      credential.status !== 1
    ) {
      throw boardFailure('UNAUTHENTICATED');
    }
    if (boardId !== null) {
      const [bindings] = await connection.execute<BindingRow[]>(
        `
        SELECT CAST(grant_id AS CHAR) AS grantPk
        FROM mcp_grant_boards
        WHERE grant_id = ? AND board_public_id = ?
        FOR UPDATE
      `,
        [principal.grantPk.toString(), boardId],
      );
      if (
        bindings.length !== 1 ||
        parseDatabasePk(bindings[0]?.grantPk ?? '') !== principal.grantPk
      ) {
        throw this.authorizationDenied(boardId);
      }
    }
    const board = await this.authorizeBoardTarget(
      connection,
      input,
      boardId,
      principal.ownerUserPk,
      principal.grantPk,
    );
    const policy =
      board === null
        ? DEFAULT_DENY_UNTARGETED_POLICY
        : await this.readArtifactPolicy(connection, board, board.ownerUserPk, transactionNowSql);
    const createBinding =
      input.operation === 'board.create'
        ? this.createBindingCapability(connection, principal, transactionNowSql)
        : null;
    return {
      actor: principal.actor,
      ownerUserPk: board?.ownerUserPk ?? principal.ownerUserPk,
      accountUserPk: principal.ownerUserPk,
      access: { kind: 'grant', grantPk: principal.grantPk, grantId: principal.grantId },
      createBinding,
      createOwnerMembership:
        input.operation === 'board.create' && this.membershipAuthorization !== null
          ? {
              create: (boardPk, createdAtSql) =>
                this.membershipAuthorization!.createOwnerMembership(connection, {
                  boardPk,
                  ownerAccountPk: principal.ownerUserPk,
                  createdAtSql,
                }),
            }
          : null,
      membership: board?.membership ?? null,
      artifactCapabilityPolicy: policy,
    };
  }

  private async authorizeBoardTarget(
    connection: PoolConnection,
    input: AuthorizedBoardTransactionInputV1,
    boardId: BoardId | null,
    ownerUserPk: bigint,
    grantPk: bigint | null,
  ): Promise<{
    boardPk: bigint;
    ownerUserPk: bigint;
    archivedAt: string | null;
    capabilityEpoch: number;
    membership: MembershipAuthorizationContextV1 | null;
  } | null> {
    if (boardId === null) return null;
    const write = input.isolation === 'READ_COMMITTED_WRITE';
    const [rows] = await connection.execute<BoardAuthorizationRow[]>(
      `
      SELECT
        CAST(b.board_pk AS CHAR) AS boardPk,
        CAST(b.owner_user_id AS CHAR) AS ownerUserPk,
        b.archived_at AS archivedAt
        , CAST(b.capability_epoch AS CHAR) AS capabilityEpoch
      FROM boards b
      WHERE b.public_id = ?
      LIMIT 1
      ${write ? 'FOR UPDATE' : ''}
    `,
      [boardId],
    );
    const board = rows[0];
    if (board === undefined) {
      if (grantPk !== null && this.membershipAuthorization === null)
        throw boardFailure('FORBIDDEN');
      throw boardFailure('BOARD_NOT_FOUND');
    }
    const boardPk = parseDatabasePk(board.boardPk);
    const canonicalOwnerUserPk = parseDatabasePk(board.ownerUserPk);
    const capabilityEpoch = board.capabilityEpoch === undefined ? 0 : Number(board.capabilityEpoch);
    if (!Number.isSafeInteger(capabilityEpoch) || capabilityEpoch < 0)
      throw boardFailure('INTERNAL_ERROR');
    let membership: MembershipAuthorizationContextV1 | null = null;
    if (this.membershipAuthorization === null) {
      if (canonicalOwnerUserPk !== ownerUserPk) throw boardFailure('FORBIDDEN');
    } else {
      try {
        membership = await this.membershipAuthorization.authorize(connection, {
          boardPk,
          canonicalOwnerAccountPk: canonicalOwnerUserPk,
          accountPk: ownerUserPk,
          ...(board.capabilityEpoch === undefined ? {} : { capabilityEpoch }),
          operation: input.operation,
          surface: input.principal.kind === 'mcp' ? 'mcp' : 'browser',
          write,
        });
      } catch (error) {
        if (error instanceof MembershipAuthorizationDeniedError)
          throw boardFailure('BOARD_NOT_FOUND');
        if (error instanceof MembershipAuthorizationInvariantError)
          throw boardFailure('INTERNAL_ERROR');
        if (error instanceof MembershipRowIntegrityError) throw boardFailure('INTERNAL_ERROR');
        throw error;
      }
    }
    if (authorizationRuleFor(input.operation).activeBoardRequired && board.archivedAt !== null) {
      throw archivedBoardFailure(boardId, board.archivedAt);
    }
    return {
      boardPk,
      ownerUserPk: canonicalOwnerUserPk,
      archivedAt: board.archivedAt,
      capabilityEpoch,
      membership,
    };
  }

  private authorizationDenied(boardId: BoardId | null): BoardContractError {
    return boardId !== null && this.membershipAuthorization !== null
      ? boardFailure('BOARD_NOT_FOUND')
      : boardFailure('FORBIDDEN');
  }

  private async readArtifactPolicy(
    connection: PoolConnection,
    board: { boardPk: bigint },
    ownerUserPk: bigint,
    transactionNowSql: string,
  ): Promise<CurrentArtifactCapabilityPolicyV1> {
    let [epochs] = await connection.execute<PolicyEpochRow[]>(
      `
      SELECT CAST(owner_user_pk AS CHAR) AS ownerUserPk, policy_epoch AS policyEpoch
      FROM board_artifact_capability_policy_epochs
      WHERE board_pk = ?
      FOR UPDATE
    `,
      [board.boardPk.toString()],
    );
    if (epochs.length === 0) {
      const epoch = this.crypto.random(16);
      await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_artifact_capability_policy_epochs (
          board_pk, owner_user_pk, policy_epoch, updated_at
        )
        SELECT board_pk, owner_user_id, ?, ?
        FROM boards
        WHERE board_pk = ? AND owner_user_id = ?
        ON DUPLICATE KEY UPDATE board_pk = VALUES(board_pk)
      `,
        [epoch, transactionNowSql, board.boardPk.toString(), ownerUserPk.toString()],
      );
      [epochs] = await connection.execute<PolicyEpochRow[]>(
        `
        SELECT CAST(owner_user_pk AS CHAR) AS ownerUserPk, policy_epoch AS policyEpoch
        FROM board_artifact_capability_policy_epochs
        WHERE board_pk = ?
        FOR UPDATE
      `,
        [board.boardPk.toString()],
      );
    }
    const epoch = epochs[0];
    if (
      epochs.length !== 1 ||
      epoch === undefined ||
      parseDatabasePk(epoch.ownerUserPk) !== ownerUserPk ||
      !Buffer.isBuffer(epoch.policyEpoch) ||
      epoch.policyEpoch.byteLength !== 16
    ) {
      throw boardFailure('INTERNAL_ERROR');
    }
    const [policyRows] = await connection.execute<PolicyCapabilityRow[]>(
      `
      SELECT capability
      FROM board_artifact_capability_policies
      WHERE board_pk = ? AND owner_user_pk = ?
      ORDER BY capability ASC
    `,
      [board.boardPk.toString(), ownerUserPk.toString()],
    );
    const known = new Set<string>(ARTIFACT_REQUEST_CAPABILITIES_V1);
    const capabilities: ArtifactRequestCapabilityV1[] = [];
    for (const row of policyRows) {
      if (
        !known.has(row.capability) ||
        capabilities.includes(row.capability as ArtifactRequestCapabilityV1)
      ) {
        throw boardFailure('INTERNAL_ERROR');
      }
      capabilities.push(row.capability as ArtifactRequestCapabilityV1);
    }
    capabilities.sort();
    return Object.freeze({
      allowedArtifactRequestCapabilities: Object.freeze(capabilities),
      policyEpoch: epoch.policyEpoch.toString('base64url'),
    });
  }

  private createBindingCapability(
    connection: PoolConnection,
    principal: Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }>,
    transactionNowSql: string,
  ): CreateBoardBindingCapabilityV1 {
    let used = false;
    return {
      grantPk: principal.grantPk,
      grantId: principal.grantId,
      bindCreatedBoard: async (candidate: BoardId) => {
        if (used) throw boardFailure('INTERNAL_ERROR');
        used = true;
        const boardId = validateBoardId(candidate);
        const [result] = await connection.execute<ResultSetHeader>(
          `
          INSERT INTO mcp_grant_boards (grant_id, board_public_id, created_at)
          SELECT id, ?, ?
          FROM mcp_grants
          WHERE id = ? AND public_id = ? AND owner_user_id = ?
            AND status = 2 AND expires_at > ?
        `,
          [
            boardId,
            transactionNowSql,
            principal.grantPk.toString(),
            principal.grantId,
            principal.ownerUserPk.toString(),
            transactionNowSql,
          ],
        );
        if (result.affectedRows !== 1) throw boardFailure('INTERNAL_ERROR');
      },
    };
  }
}
