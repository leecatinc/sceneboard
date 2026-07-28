import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ShareFingerprintInputParserV1,
  SharePasswordReplayResultParserV1,
  SharePasswordSuccessParserV1,
  canonicalizeJsonV1,
  type BoardId,
  type SharePasswordReplayResultV1,
  type SharePasswordSuccessV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { SessionRecord } from '../auth/session.service.js';
import { ShareContractError } from '../common/errors/app-error.js';
import type { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import type {
  BoardAccessOperationV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import type { PasswordAttemptService } from './password-attempt.service.js';
import {
  PasswordHashService,
  PasswordVerificationPool,
  PasswordVerificationPoolFullError,
  SHARE_PASSWORD_HASH_VERSION,
  SHARE_PASSWORD_PEPPER_VERSION,
  type PasswordHashRecord,
} from './password-hash.service.js';
import { PasswordShareRepository, passwordDatabaseNow } from './password-share.repository.js';
import type { ShareCookieService } from './share-cookie.service.js';
import {
  shareStateDigest,
  shareView,
  type LockedShareCredential,
  type ShareRepository,
} from './share.repository.js';
import type { ShareTokenService } from './share-token.service.js';
import type { ShareTransitionRecoveryService } from './share-transition-recovery.service.js';

type OwnerContext = {
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  session: SessionRecord;
  boardId: BoardId;
};

type PasswordOwnerOperation = 'password.enable' | 'password.regenerate' | 'password.disable';

const safeBoardPk = (
  context: Parameters<Parameters<BoardAccessPolicy['withAuthorizedBoardTransaction']>[1]>[1],
): bigint => {
  if (context.membership == null) throw new ShareContractError('BOARD_NOT_FOUND');
  return context.membership.boardPk;
};

const authorizationOperation = (operation: PasswordOwnerOperation): BoardAccessOperationV1 =>
  operation === 'password.enable'
    ? 'share.password.enable'
    : operation === 'password.regenerate'
      ? 'share.password.regenerate'
      : 'share.password.disable';

const fingerprint = (input: {
  operation: PasswordOwnerOperation;
  shareId: string;
  expectedVersion: number;
}): Buffer => {
  const parsed = ShareFingerprintInputParserV1.parse({
    operation: input.operation,
    shareId: input.shareId,
    expectedVersion: input.expectedVersion,
    pinnedRevisionId: null,
  });
  if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
  const canonical = canonicalizeJsonV1(parsed.data.value);
  if (!canonical.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
  return createHash('sha256').update(canonical.data.canonicalBytes).digest();
};

const replay = (
  operation: 'password.enable' | 'password.regenerate',
  shareId: string,
): SharePasswordReplayResultV1 => {
  const parsed = SharePasswordReplayResultParserV1.parse({
    status: operation === 'password.enable' ? 'already-enabled' : 'already-regenerated',
    shareId,
    copySecretAvailable: false,
    regenerateRequired: true,
  });
  if (!parsed.ok) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
  return parsed.data.value;
};

const credentialFromHash = (
  hash: PasswordHashRecord,
  credentialVersion: number,
): LockedShareCredential => ({
  credentialVersion,
  passwordHash: Buffer.from(hash.passwordHash),
  passwordHashSha256: createHash('sha256').update(hash.passwordHash).digest(),
  salt: Buffer.from(hash.salt),
  hashVersion: SHARE_PASSWORD_HASH_VERSION,
  pepperVersion: SHARE_PASSWORD_PEPPER_VERSION,
});

const tupleEqual = (left: LockedShareCredential, right: LockedShareCredential): boolean =>
  left.credentialVersion === right.credentialVersion &&
  left.hashVersion === right.hashVersion &&
  left.pepperVersion === right.pepperVersion &&
  left.passwordHash.byteLength === right.passwordHash.byteLength &&
  left.salt.byteLength === right.salt.byteLength &&
  timingSafeEqual(left.passwordHash, right.passwordHash) &&
  timingSafeEqual(left.salt, right.salt);

export class PasswordShareService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly mysql: MysqlService,
    private readonly shares: ShareRepository,
    private readonly passwords: PasswordShareRepository,
    private readonly recovery: ShareTransitionRecoveryService,
    private readonly tokens: ShareTokenService,
    private readonly hasher: PasswordHashService,
    private readonly attempts: PasswordAttemptService,
    private readonly cookies: ShareCookieService,
    private readonly pool = new PasswordVerificationPool(8),
  ) {}

  async enable(
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<SharePasswordSuccessV1 | SharePasswordReplayResultV1> {
    const result = await this.ownerTransition('password.enable', input);
    if (result === undefined) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
    return result;
  }

  async regenerate(
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<SharePasswordSuccessV1 | SharePasswordReplayResultV1> {
    const result = await this.ownerTransition('password.regenerate', input);
    if (result === undefined) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
    return result;
  }

  async disable(
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await this.ownerTransition('password.disable', input);
  }

  async admit(input: {
    shareToken: string;
    password: string;
    ip: string;
    hostname: string;
    familyToken?: string | undefined;
  }): Promise<{ setCookie: string | null }> {
    let tokenDigest: Buffer;
    try {
      tokenDigest = this.tokens.digest(input.shareToken);
    } catch {
      throw new ShareContractError('BOARD_NOT_FOUND');
    }
    await this.attempts.assertUnlocked(tokenDigest, input.ip);
    const observed = await this.withPasswordStore((connection) =>
      this.shares.readShareByTokenDigest(connection, tokenDigest),
    );
    const credential = observed?.credential ?? {
      credentialVersion: 1,
      passwordHash: Buffer.alloc(32),
      passwordHashSha256: createHash('sha256').update(Buffer.alloc(32)).digest(),
      salt: Buffer.alloc(16),
      hashVersion: SHARE_PASSWORD_HASH_VERSION,
      pepperVersion: SHARE_PASSWORD_PEPPER_VERSION,
    };
    let valid: boolean;
    try {
      valid = await this.pool.run(() => this.hasher.verify(input.password, credential));
    } catch (error) {
      if (error instanceof PasswordVerificationPoolFullError) {
        throw new ShareContractError('RATE_LIMITED', 1);
      }
      throw error;
    }
    if (
      !valid ||
      observed === null ||
      observed.status !== 'active' ||
      observed.accessPolicy !== 'P' ||
      observed.credential === null
    ) {
      await this.attempts.recordFailure(tokenDigest, input.ip);
      throw new ShareContractError('BOARD_NOT_FOUND');
    }
    await this.attempts.clearLink(tokenDigest, input.ip);
    return this.withPasswordStore((connection) =>
      withTransaction(connection, 'READ COMMITTED', async () => {
        const share = await this.shares.lockShareByTokenDigest(connection, tokenDigest);
        if (
          share === null ||
          share.status !== 'active' ||
          share.accessPolicy !== 'P' ||
          share.credential === null ||
          !tupleEqual(share.credential, observed.credential!)
        ) {
          throw new ShareContractError('BOARD_NOT_FOUND');
        }
        const nowSql = await passwordDatabaseNow(connection);
        let familyDigest: Buffer | null = null;
        let familyExpiresAt: string | null = null;
        if (input.familyToken !== undefined) {
          try {
            familyDigest = this.cookies.familyDigest(input.familyToken);
            familyExpiresAt = await this.passwords.lockFamily(connection, familyDigest, nowSql);
          } catch {
            familyDigest = null;
            familyExpiresAt = null;
          }
        }
        let setCookie: string | null = null;
        if (familyDigest === null || familyExpiresAt === null) {
          const issued = this.cookies.issueFamily(input.hostname);
          familyDigest = issued.digest;
          familyExpiresAt = await this.passwords.createFamily(connection, issued.digest, nowSql);
          setCookie = issued.setCookie;
        }
        await this.passwords.upsertGrant(connection, {
          familyDigest,
          share,
          credential: share.credential,
          familyExpiresAtSql: familyExpiresAt,
          nowSql,
        });
        return { setCookie };
      }),
    );
  }

  private async withPasswordStore<Value>(
    operation: (connection: PoolConnection) => Promise<Value>,
  ): Promise<Value> {
    try {
      return await this.mysql.withConnection(operation);
    } catch (error) {
      if (error instanceof ShareContractError) throw error;
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1, undefined, error);
    }
  }

  private async ownerTransition(
    operation: PasswordOwnerOperation,
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<SharePasswordSuccessV1 | SharePasswordReplayResultV1 | undefined> {
    const generated =
      operation === 'password.disable'
        ? null
        : {
            password: this.hasher.generate(),
          };
    const hash = generated === null ? null : await this.hasher.hash(generated.password);
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: authorizationOperation(operation),
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const boardPk = safeBoardPk(context);
        await this.shares.assertBoardActive(connection, boardPk);
        const operationFingerprint = fingerprint({
          operation,
          shareId: input.shareId,
          expectedVersion: input.expectedVersion,
        });
        const stored = await this.shares.findReplay(connection, {
          accountPk: input.principal.userPk,
          boardPk,
          idempotencyKey: input.idempotencyKey,
          operations: [operation],
          fingerprintSha256: operationFingerprint,
        });
        if (stored !== null) {
          if (stored.operation !== operation) {
            throw new ShareContractError('IDEMPOTENCY_KEY_REUSED');
          }
          if (operation === 'password.disable') return undefined;
          if (
            stored.operation !== 'password.enable' &&
            stored.operation !== 'password.regenerate'
          ) {
            throw new ShareContractError('IDEMPOTENCY_KEY_REUSED');
          }
          return stored.value;
        }
        const share = await this.shares.lockShare(connection, boardPk);
        if (share === null || share.shareId !== input.shareId) {
          throw new ShareContractError('BOARD_NOT_FOUND');
        }
        if (share.status !== 'active' || share.version !== input.expectedVersion) {
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        }
        if (operation === 'password.enable' && (share.accessPolicy !== 'L' || share.credential)) {
          throw new ShareContractError('SHARE_PASSWORD_ALREADY_ENABLED');
        }
        if (
          operation === 'password.regenerate' &&
          (share.accessPolicy !== 'P' || share.credential === null)
        ) {
          throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
        }
        const noChange =
          operation === 'password.disable' &&
          share.accessPolicy === 'L' &&
          share.credential === null;
        const nextCredential =
          operation === 'password.disable'
            ? null
            : credentialFromHash(
                hash!,
                operation === 'password.enable'
                  ? 1
                  : this.shares.nextGeneration(share.credential!.credentialVersion),
              );
        const nextAccessGeneration = noChange
          ? share.accessGeneration
          : this.shares.nextGeneration(share.accessGeneration);
        const nextVersion = noChange ? share.version : this.shares.nextGeneration(share.version);
        const nowSql = await passwordDatabaseNow(connection);
        const recoveryId = noChange ? null : this.shares.newRecoveryId();
        const leaseOwner = recoveryId === null ? null : `${input.session.publicId}:${recoveryId}`;
        if (recoveryId !== null && leaseOwner !== null) {
          await this.recovery.plan(connection, {
            recoveryId,
            boardPk,
            sharePk: share.sharePk,
            operation,
            fingerprintSha256: operationFingerprint,
            beforeSha256: shareStateDigest(share),
            afterSha256: shareStateDigest({
              ...share,
              accessPolicy: operation === 'password.disable' ? 'L' : 'P',
              accessGeneration: nextAccessGeneration,
              version: nextVersion,
              credential: nextCredential,
            }),
            oldRevisionPk: share.pinnedRevisionPk,
            newRevisionPk: share.pinnedRevisionPk,
            leaseOwner,
            nowSql,
            credentialMarker:
              nextCredential === null
                ? null
                : {
                    credentialVersion: nextCredential.credentialVersion,
                    passwordHashSha256: nextCredential.passwordHashSha256,
                    pepperVersion: nextCredential.pepperVersion,
                  },
          });
        }
        const updated =
          operation === 'password.enable'
            ? await this.passwords.enable(connection, share, hash!, nowSql)
            : operation === 'password.regenerate'
              ? await this.passwords.regenerate(connection, share, hash!, nowSql)
              : await this.passwords.disable(connection, share, nowSql);
        if (!noChange) {
          await this.shares.appendInvalidation(connection, {
            boardPk,
            boardId: input.boardId,
            nowSql,
          });
          await this.shares.writeAudit(connection, {
            event:
              operation === 'password.enable'
                ? 'share.password.enabled'
                : operation === 'password.regenerate'
                  ? 'share.password.regenerated'
                  : 'share.password.disabled',
            actorPublicId: context.actor.principalId,
            userPublicId: input.session.user.publicId,
            sessionPublicId: input.session.publicId,
            metadata: {
              boardPk: boardPk.toString(),
              sharePk: updated.sharePk.toString(),
              accessGeneration: updated.accessGeneration,
              credentialVersion: updated.credential?.credentialVersion ?? null,
              recoveryId,
            },
          });
          await this.recovery.markCoreApplied(connection, {
            recoveryId: recoveryId!,
            sharePk: updated.sharePk,
            leaseOwner: leaseOwner!,
            nowSql,
          });
          await this.recovery.complete(connection, {
            recoveryId: recoveryId!,
            share: updated,
            leaseOwner: leaseOwner!,
            nowSql,
          });
        }
        const storedResult =
          operation === 'password.disable'
            ? { status: 'disabled', shareId: share.shareId }
            : replay(operation, share.shareId);
        await this.shares.persistIdempotency(connection, {
          accountPk: input.principal.userPk,
          boardPk,
          operation,
          idempotencyKey: input.idempotencyKey,
          fingerprintSha256: operationFingerprint,
          resultKind:
            operation === 'password.enable'
              ? 'password-enabled'
              : operation === 'password.regenerate'
                ? 'password-regenerated'
                : 'password-disabled',
          result: storedResult,
          sharePk: share.sharePk,
          recoveryId,
          nowSql,
        });
        if (operation === 'password.disable') return undefined;
        const parsed = SharePasswordSuccessParserV1.parse({
          status: operation === 'password.enable' ? 'enabled' : 'regenerated',
          share: shareView(updated),
          password: generated!.password,
        });
        if (!parsed.ok) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
        return parsed.data.value;
      },
    );
  }
}
