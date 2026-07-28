import { createHash } from 'node:crypto';

import {
  SharePublishSuccessParserV1,
  ShareFingerprintInputParserV1,
  ShareRotateSuccessParserV1,
  ShareSecretReplayResultParserV1,
  ShareUpdateSuccessParserV1,
  canonicalizeJsonV1,
  type BoardId,
  type RevisionId,
  type ShareListResultV1,
  type SharePublishSuccessV1,
  type ShareRotateSuccessV1,
  type ShareSecretReplayResultV1,
  type ShareUpdateSuccessV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { SessionRecord } from '../auth/session.service.js';
import { ShareContractError } from '../common/errors/app-error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type {
  BoardAccessOperationV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { MediaRetentionService } from '../media/media-retention.service.js';
import {
  shareStateDigest,
  shareView,
  type LockedShare,
  type LockedShareRevision,
  type ShareOperation,
  type ShareRepository,
  type StoredShareReplay,
} from './share.repository.js';
import type { ShareTokenService } from './share-token.service.js';
import type { ShareTransitionRecoveryService } from './share-transition-recovery.service.js';

interface ClockRow extends RowDataPacket {
  nowSql: string;
}

type OwnerContext = {
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  session: SessionRecord;
  boardId: BoardId;
};

type PlannedTransition = {
  operation: ShareOperation;
  recoveryId: string;
  leaseOwner: string;
  boardPk: bigint;
  before: LockedShare | null;
  revision: LockedShareRevision;
  shareId: string;
  token: string | null;
  tokenDigest: Buffer;
  expectedVersion: number | null;
  fingerprintSha256: Buffer;
  idempotencyKey: string;
};

type PlanOrReplay = { replay: StoredShareReplay } | { plan: PlannedTransition };

const databaseNow = async (connection: PoolConnection): Promise<string> => {
  const [rows] = await connection.execute<ClockRow[]>('SELECT UTC_TIMESTAMP(3) AS nowSql');
  const nowSql = rows[0]?.nowSql;
  if (nowSql === undefined) throw new ShareContractError('SHARE_STATE_CONFLICT');
  parseMysqlTimestampUtc(nowSql);
  return nowSql;
};

const safeBoardPk = (
  context: Parameters<Parameters<BoardAccessPolicy['withAuthorizedBoardTransaction']>[1]>[1],
): bigint => {
  if (context.membership == null) throw new ShareContractError('BOARD_NOT_FOUND');
  return context.membership.boardPk;
};

const fingerprint = (input: {
  operation: ShareOperation;
  shareId: string | null;
  expectedVersion: number | null;
  pinnedRevisionId: RevisionId | null;
}): Buffer => {
  const strict = ShareFingerprintInputParserV1.parse(input);
  if (!strict.ok) throw new ShareContractError('INVALID_REQUEST');
  const parsed = canonicalizeJsonV1(strict.data.value);
  if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
  return createHash('sha256').update(parsed.data.canonicalBytes).digest();
};

const authorizationOperation = (operation: ShareOperation | 'list'): BoardAccessOperationV1 =>
  operation === 'list'
    ? 'share.list'
    : operation === 'create' || operation === 'republish'
      ? 'share.publish'
      : operation === 'update'
        ? 'share.update'
        : operation === 'rotate'
          ? 'share.rotate'
          : 'share.revoke';

const secretReplay = (
  operation: 'create' | 'republish' | 'rotate',
  shareId: string,
): ShareSecretReplayResultV1 => {
  const parsed = ShareSecretReplayResultParserV1.parse({
    status:
      operation === 'create'
        ? 'already-created'
        : operation === 'republish'
          ? 'already-republished'
          : 'already-rotated',
    shareId,
    copySecretAvailable: false,
    rotateRequired: true,
  });
  if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
  return parsed.data.value;
};

const replayValue = (replay: StoredShareReplay) => replay.value;

export class SharePublicationService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly shares: ShareRepository,
    private readonly recovery: ShareTransitionRecoveryService,
    private readonly tokens: ShareTokenService,
    private readonly rateLimits: RateLimitService,
    private readonly mediaRetention: MediaRetentionService,
  ) {}

  async list(input: OwnerContext): Promise<ShareListResultV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: authorizationOperation('list'),
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const share = await this.shares.readShare(connection, safeBoardPk(context));
        return { shares: share === null ? [] : [shareView(share)] };
      },
    );
  }

  async publish(
    input: OwnerContext & {
      pinnedRevisionId: RevisionId;
      idempotencyKey: string;
    },
  ): Promise<
    | { replayed: false; value: SharePublishSuccessV1 }
    | { replayed: true; value: ShareSecretReplayResultV1 }
  > {
    await this.limit(input, 'share-publish');
    const planned = await this.planPublish(input);
    if ('replay' in planned)
      return { replayed: true, value: replayValue(planned.replay) as ShareSecretReplayResultV1 };
    const result = await this.apply(planned.plan, input);
    if ('replay' in result)
      return { replayed: true, value: replayValue(result.replay) as ShareSecretReplayResultV1 };
    const parsed = SharePublishSuccessParserV1.parse({
      status: planned.plan.operation === 'create' ? 'created' : 'republished',
      share: shareView(result.share),
      linkToken: planned.plan.token,
    });
    if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
    await this.cleanup(planned.plan, input, result.share);
    return { replayed: false, value: parsed.data.value };
  }

  async update(
    input: OwnerContext & {
      shareId: string;
      pinnedRevisionId: RevisionId;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<ShareUpdateSuccessV1> {
    await this.limit(input, 'share-update');
    const planned = await this.planExisting(input, 'update', null);
    if ('replay' in planned) return replayValue(planned.replay) as ShareUpdateSuccessV1;
    const result = await this.apply(planned.plan, input);
    if ('replay' in result) return replayValue(result.replay) as ShareUpdateSuccessV1;
    await this.cleanup(planned.plan, input, result.share);
    return result.updateResult!;
  }

  async rotate(
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<
    | { replayed: false; value: ShareRotateSuccessV1 }
    | { replayed: true; value: ShareSecretReplayResultV1 }
  > {
    await this.limit(input, 'share-rotate');
    const issued = this.tokens.issue();
    const planned = await this.planExisting(input, 'rotate', issued);
    if ('replay' in planned)
      return { replayed: true, value: replayValue(planned.replay) as ShareSecretReplayResultV1 };
    const result = await this.apply(planned.plan, input);
    if ('replay' in result)
      return { replayed: true, value: replayValue(result.replay) as ShareSecretReplayResultV1 };
    const parsed = ShareRotateSuccessParserV1.parse({
      status: 'rotated',
      share: shareView(result.share),
      linkToken: planned.plan.token,
    });
    if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
    await this.cleanup(planned.plan, input, result.share);
    return { replayed: false, value: parsed.data.value };
  }

  async revoke(
    input: OwnerContext & {
      shareId: string;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await this.limit(input, 'share-revoke');
    const planned = await this.planExisting(input, 'revoke', null);
    if ('replay' in planned) return;
    const result = await this.apply(planned.plan, input);
    if ('replay' in result) return;
    await this.cleanup(planned.plan, input, result.share);
  }

  private async planPublish(
    input: OwnerContext & {
      pinnedRevisionId: RevisionId;
      idempotencyKey: string;
    },
  ): Promise<PlanOrReplay> {
    const issued = this.tokens.issue();
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: authorizationOperation('create'),
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const boardPk = safeBoardPk(context);
        await this.shares.assertBoardActive(connection, boardPk);
        const share = await this.shares.lockShare(connection, boardPk);
        for (const operation of ['create', 'republish'] as const) {
          const replay = await this.shares.findReplay(connection, {
            accountPk: input.principal.userPk,
            boardPk,
            idempotencyKey: input.idempotencyKey,
            operations: [operation],
            fingerprintSha256: fingerprint({
              operation,
              shareId: null,
              expectedVersion: null,
              pinnedRevisionId: input.pinnedRevisionId,
            }),
          });
          if (replay !== null) return { replay };
        }
        const operation: ShareOperation =
          share === null ? 'create' : share.status === 'revoked' ? 'republish' : 'create';
        if (share !== null && share.status !== 'revoked') {
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        }
        const revision = await this.shares.lockRevision(
          connection,
          boardPk,
          input.pinnedRevisionId,
        );
        const shareId = share?.shareId ?? this.shares.newShareId();
        const publicationGeneration =
          share === null ? 1 : this.shares.nextGeneration(share.publicationGeneration);
        const accessGeneration =
          share === null ? 1 : this.shares.nextGeneration(share.accessGeneration);
        const version = share === null ? 1 : this.shares.nextGeneration(share.version);
        const recoveryId = this.shares.newRecoveryId();
        const leaseOwner = `${input.session.publicId}:${recoveryId}`;
        const operationFingerprint = fingerprint({
          operation,
          shareId: null,
          expectedVersion: null,
          pinnedRevisionId: input.pinnedRevisionId,
        });
        const nowSql = await databaseNow(connection);
        await this.recovery.plan(connection, {
          recoveryId,
          boardPk,
          sharePk: share?.sharePk ?? null,
          operation,
          fingerprintSha256: operationFingerprint,
          beforeSha256: shareStateDigest(share),
          afterSha256: shareStateDigest({
            shareId,
            boardPk,
            status: 'active',
            accessPolicy: 'L',
            pinnedRevisionPk: revision.revisionPk,
            publicationGeneration,
            accessGeneration,
            tokenDigest: issued.digest,
            version,
            credential: null,
          }),
          oldRevisionPk: share?.pinnedRevisionPk ?? null,
          newRevisionPk: revision.revisionPk,
          leaseOwner,
          nowSql,
          credentialMarker: null,
        });
        return {
          plan: {
            operation,
            recoveryId,
            leaseOwner,
            boardPk,
            before: share,
            revision,
            shareId,
            token: issued.token,
            tokenDigest: issued.digest,
            expectedVersion: null,
            fingerprintSha256: operationFingerprint,
            idempotencyKey: input.idempotencyKey,
          },
        };
      },
    );
  }

  private async planExisting(
    input: OwnerContext & {
      shareId: string;
      pinnedRevisionId?: RevisionId;
      expectedVersion: number;
      idempotencyKey: string;
    },
    operation: 'update' | 'rotate' | 'revoke',
    issued: { token: string; digest: Buffer } | null,
  ): Promise<PlanOrReplay> {
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
          pinnedRevisionId: input.pinnedRevisionId ?? null,
        });
        const replay = await this.shares.findReplay(connection, {
          accountPk: input.principal.userPk,
          boardPk,
          idempotencyKey: input.idempotencyKey,
          operations: [operation],
          fingerprintSha256: operationFingerprint,
        });
        if (replay !== null) return { replay };
        const share = await this.shares.lockShare(connection, boardPk);
        if (share === null || share.shareId !== input.shareId) {
          throw new ShareContractError('BOARD_NOT_FOUND');
        }
        if (share.status !== 'active' || share.version !== input.expectedVersion) {
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        }
        const revision =
          operation === 'update'
            ? await this.shares.lockRevision(connection, boardPk, input.pinnedRevisionId!)
            : {
                revisionPk: share.pinnedRevisionPk,
                revisionId: share.pinnedRevisionId,
              };
        const samePin = revision.revisionPk === share.pinnedRevisionPk;
        const publicationGeneration =
          operation === 'update' && !samePin
            ? this.shares.nextGeneration(share.publicationGeneration)
            : share.publicationGeneration;
        const accessGeneration =
          operation === 'rotate' || operation === 'revoke'
            ? this.shares.nextGeneration(share.accessGeneration)
            : share.accessGeneration;
        const version =
          operation === 'update' && samePin
            ? share.version
            : this.shares.nextGeneration(share.version);
        const tokenDigest = issued?.digest ?? share.tokenDigest;
        const nextStatus = operation === 'revoke' ? 'revoked' : 'active';
        const recoveryId = this.shares.newRecoveryId();
        const leaseOwner = `${input.session.publicId}:${recoveryId}`;
        const nowSql = await databaseNow(connection);
        await this.recovery.plan(connection, {
          recoveryId,
          boardPk,
          sharePk: share.sharePk,
          operation,
          fingerprintSha256: operationFingerprint,
          beforeSha256: shareStateDigest(share),
          afterSha256: shareStateDigest({
            shareId: share.shareId,
            boardPk,
            status: nextStatus,
            accessPolicy: operation === 'revoke' ? 'L' : share.accessPolicy,
            pinnedRevisionPk: revision.revisionPk,
            publicationGeneration,
            accessGeneration,
            tokenDigest,
            version,
            credential: operation === 'revoke' ? null : share.credential,
          }),
          oldRevisionPk: share.pinnedRevisionPk,
          newRevisionPk: revision.revisionPk,
          leaseOwner,
          nowSql,
          credentialMarker:
            operation === 'revoke' || share.credential === null
              ? null
              : {
                  credentialVersion: share.credential.credentialVersion,
                  passwordHashSha256: share.credential.passwordHashSha256,
                  pepperVersion: share.credential.pepperVersion,
                },
        });
        return {
          plan: {
            operation,
            recoveryId,
            leaseOwner,
            boardPk,
            before: share,
            revision,
            shareId: share.shareId,
            token: issued?.token ?? null,
            tokenDigest,
            expectedVersion: input.expectedVersion,
            fingerprintSha256: operationFingerprint,
            idempotencyKey: input.idempotencyKey,
          },
        };
      },
    );
  }

  private async apply(
    plan: PlannedTransition,
    input: OwnerContext,
  ): Promise<
    | { replay: StoredShareReplay }
    | { share: LockedShare; updateResult: ShareUpdateSuccessV1 | null }
  > {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: authorizationOperation(plan.operation),
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        const boardPk = safeBoardPk(context);
        await this.shares.assertBoardActive(connection, boardPk);
        if (boardPk !== plan.boardPk) throw new ShareContractError('BOARD_NOT_FOUND');
        const existingReplay = await this.shares.findReplay(connection, {
          accountPk: input.principal.userPk,
          boardPk,
          idempotencyKey: plan.idempotencyKey,
          operations: [plan.operation],
          fingerprintSha256: plan.fingerprintSha256,
        });
        if (existingReplay !== null) return { replay: existingReplay };
        const current = await this.shares.lockShare(connection, boardPk);
        if (!this.matchesBefore(plan, current))
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        await this.shares.lockRevision(connection, boardPk, plan.revision.revisionId);
        const nowSql = await databaseNow(connection);
        let updated: LockedShare;
        let updateResult: ShareUpdateSuccessV1 | null = null;
        if (plan.operation === 'create') {
          updated = await this.shares.createShare(connection, {
            shareId: plan.shareId,
            boardPk,
            revisionPk: plan.revision.revisionPk,
            tokenDigest: plan.tokenDigest,
            nowSql,
          });
          await this.acquirePublication(connection, updated);
        } else if (plan.operation === 'republish') {
          updated = await this.shares.republish(
            connection,
            current!,
            plan.revision.revisionPk,
            plan.tokenDigest,
            nowSql,
          );
          await this.acquirePublication(connection, updated);
        } else if (plan.operation === 'update') {
          if (current!.pinnedRevisionPk === plan.revision.revisionPk) {
            updated = current!;
            const parsed = ShareUpdateSuccessParserV1.parse({
              status: 'unchanged',
              share: shareView(updated),
            });
            if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
            updateResult = parsed.data.value;
          } else {
            updated = await this.shares.updatePin(
              connection,
              current!,
              plan.revision.revisionPk,
              nowSql,
            );
            await this.acquirePublication(connection, updated);
            await this.releasePublication(connection, current!, nowSql);
            const parsed = ShareUpdateSuccessParserV1.parse({
              status: 'updated',
              share: shareView(updated),
            });
            if (!parsed.ok) throw new ShareContractError('SHARE_STATE_CONFLICT');
            updateResult = parsed.data.value;
          }
        } else if (plan.operation === 'rotate') {
          updated = await this.shares.rotate(connection, current!, plan.tokenDigest, nowSql);
        } else if (plan.operation === 'revoke') {
          updated = await this.shares.revoke(connection, current!, nowSql);
          await this.releasePublication(connection, current!, nowSql);
        } else {
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        }
        await this.mediaRetention.applyPublicationTransition(connection, {
          sharePk: updated.sharePk,
          oldRevisionPk: current?.pinnedRevisionPk ?? null,
          newRevisionPk: updated.status === 'active' ? updated.pinnedRevisionPk : null,
          publicationGeneration: updated.publicationGeneration,
          recoveryId: plan.recoveryId,
        });
        const replay =
          plan.operation === 'update'
            ? updateResult!
            : plan.operation === 'revoke'
              ? { status: 'revoked', shareId: updated.shareId }
              : secretReplay(plan.operation, updated.shareId);
        await this.shares.persistIdempotency(connection, {
          accountPk: input.principal.userPk,
          boardPk,
          operation: plan.operation,
          idempotencyKey: plan.idempotencyKey,
          fingerprintSha256: plan.fingerprintSha256,
          resultKind:
            plan.operation === 'create'
              ? 'created'
              : plan.operation === 'republish'
                ? 'republished'
                : plan.operation === 'rotate'
                  ? 'rotated'
                  : plan.operation === 'revoke'
                    ? 'revoked'
                    : updateResult!.status,
          result: replay,
          sharePk: updated.sharePk,
          recoveryId: plan.recoveryId,
          nowSql,
        });
        await this.shares.writeAudit(connection, {
          event: this.auditEvent(plan.operation, updateResult),
          actorPublicId: input.principal.actor.principalId,
          userPublicId: input.session.user.publicId,
          sessionPublicId: input.session.publicId,
          metadata: {
            boardPk: boardPk.toString(),
            sharePk: updated.sharePk.toString(),
            publicationGeneration: updated.publicationGeneration,
            accessGeneration: updated.accessGeneration,
            recoveryId: plan.recoveryId,
          },
        });
        if (plan.operation !== 'update' || updateResult?.status !== 'unchanged') {
          await this.shares.appendInvalidation(connection, {
            boardPk,
            boardId: input.boardId,
            nowSql,
          });
        }
        await this.recovery.markCoreApplied(connection, {
          recoveryId: plan.recoveryId,
          sharePk: updated.sharePk,
          leaseOwner: plan.leaseOwner,
          nowSql,
        });
        return { share: updated, updateResult };
      },
    );
  }

  private async cleanup(
    plan: PlannedTransition,
    input: OwnerContext,
    expected: LockedShare,
  ): Promise<void> {
    await this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: authorizationOperation(plan.operation),
        boardId: input.boardId,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async (connection, context) => {
        if (safeBoardPk(context) !== plan.boardPk) throw new ShareContractError('BOARD_NOT_FOUND');
        await this.shares.assertBoardActive(connection, plan.boardPk);
        const current = await this.shares.lockShare(connection, plan.boardPk);
        if (current === null || current.sharePk !== expected.sharePk)
          throw new ShareContractError('SHARE_STATE_CONFLICT');
        const nowSql = await databaseNow(connection);
        await this.recovery.complete(connection, {
          recoveryId: plan.recoveryId,
          share: current,
          leaseOwner: plan.leaseOwner,
          nowSql,
        });
      },
    );
  }

  private matchesBefore(plan: PlannedTransition, current: LockedShare | null): boolean {
    return shareStateDigest(current).equals(shareStateDigest(plan.before));
  }

  private async acquirePublication(connection: PoolConnection, share: LockedShare): Promise<void> {
    await this.shares.acquireHold(connection, {
      boardPk: share.boardPk,
      revisionPk: share.pinnedRevisionPk,
      kind: 'published',
      holderId: this.shares.publicationHolder(share.shareId, share.publicationGeneration),
    });
  }

  private async releasePublication(
    connection: PoolConnection,
    share: LockedShare,
    nowSql: string,
  ): Promise<void> {
    await this.shares.releaseHold(connection, {
      boardPk: share.boardPk,
      revisionPk: share.pinnedRevisionPk,
      kind: 'published',
      holderId: this.shares.publicationHolder(share.shareId, share.publicationGeneration),
      nowSql,
    });
  }

  private auditEvent(
    operation: ShareOperation,
    updateResult: ShareUpdateSuccessV1 | null,
  ):
    | 'share.created'
    | 'share.republished'
    | 'share.pin.updated'
    | 'share.update.noop'
    | 'share.link.rotated'
    | 'share.revoked' {
    if (operation === 'create') return 'share.created';
    if (operation === 'republish') return 'share.republished';
    if (operation === 'rotate') return 'share.link.rotated';
    if (operation === 'revoke') return 'share.revoked';
    return updateResult?.status === 'unchanged' ? 'share.update.noop' : 'share.pin.updated';
  }

  private async limit(input: OwnerContext, surface: string): Promise<void> {
    try {
      await this.rateLimits.consume({
        surface,
        purpose: 'rate-limit-user/v1',
        identity: `${input.session.user.publicId}\0${input.boardId}`,
        limit: 30,
        windowMs: 60_000,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'RATE_LIMITED'
      ) {
        const retryAfter =
          'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
            ? error.retryAfterSeconds
            : null;
        throw new ShareContractError('RATE_LIMITED', retryAfter);
      }
      throw error;
    }
  }
}
