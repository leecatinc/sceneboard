import { Logger } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';

import type { AppEnvironment } from '../config/env.schema.js';
import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import type { AccountApiKeyAuditContext } from './account-api-key-audit.policy.js';
import {
  AccountApiKeyRepository,
  type AccountApiKeyListBoundary,
  type AccountApiKeyMetadata,
  type ActiveAccountApiKeySnapshot,
} from './account-api-key.repository.js';
import {
  accountApiKeyScopeMask,
  accountApiKeyScopesFromMask,
  parseAccountApiKeyScopes,
} from './account-api-key.scope.js';
import { AccountApiKeyTokenCodec } from './account-api-key-token.codec.js';

interface AccountApiKeyOperationalLogger {
  warn(message: unknown): void;
}

type RateLimitFailure = { error: unknown; cached: boolean } | null;

type AccountApiKeyFailureBucket = {
  surface: 'api-key-auth-failure-ip' | 'api-key-auth-failure-locator';
  purpose: 'rate-limit-ip/v1' | 'rate-limit-api-key/v1';
  identity: string;
  limit: number;
  windowMs: number;
};

const MAX_SATURATED_FAILURE_BUCKETS = 4_096;

export interface AccountApiKeyManagementActor {
  ownerUserPk: string;
  ownerPublicId: string;
  sessionPublicId: string;
  correlationId: string;
  clientIp: string;
}

export interface AccountApiKeyAuthenticationContext {
  correlationId: string;
  clientIp: string;
}

const parseName = (value: string): string => {
  if (value !== value.trim() || [...value].length < 1 || [...value].length > 80) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return value;
};

const auditContext = (actor: AccountApiKeyManagementActor): AccountApiKeyAuditContext => ({
  correlationId: actor.correlationId,
  ownerPublicId: actor.ownerPublicId,
  sessionPublicId: actor.sessionPublicId,
  actorPublicId: actor.ownerPublicId,
});

export class AccountApiKeyService {
  private readonly saturatedFailureBuckets = new Map<string, number>();

  constructor(
    private readonly repository: AccountApiKeyRepository,
    private readonly tokens: AccountApiKeyTokenCodec,
    private readonly crypto: CryptoService,
    private readonly limiter: RateLimitService,
    private readonly environment: Pick<
      AppEnvironment,
      'accountApiKeyIssuanceEnabled' | 'accountApiKeyAuthEnabled'
    >,
    private readonly operationalLogger: AccountApiKeyOperationalLogger = new Logger(
      AccountApiKeyService.name,
    ),
  ) {}

  async consumeManagementLimits(
    operation: 'issue' | 'list' | 'revoke',
    actor: AccountApiKeyManagementActor,
  ): Promise<void> {
    const policy =
      operation === 'issue'
        ? { account: 10, ip: 30, windowMs: 60 * 60 * 1_000 }
        : operation === 'list'
          ? { account: 120, ip: 240, windowMs: 60 * 1_000 }
          : { account: 30, ip: 60, windowMs: 60 * 60 * 1_000 };
    await this.limiter.consume({
      surface: `api-key-${operation}-account`,
      purpose: 'rate-limit-user/v1',
      identity: actor.ownerPublicId,
      limit: policy.account,
      windowMs: policy.windowMs,
    });
    await this.limiter.consume({
      surface: `api-key-${operation}-ip`,
      purpose: 'rate-limit-ip/v1',
      identity: actor.clientIp,
      limit: policy.ip,
      windowMs: policy.windowMs,
    });
  }

  async issue(input: {
    actor: AccountApiKeyManagementActor;
    name: string;
    scopes?: readonly string[] | undefined;
    expiresAt?: number | undefined;
    now: number;
  }): Promise<{ apiKey: string; metadata: AccountApiKeyMetadata }> {
    if (!this.environment.accountApiKeyIssuanceEnabled) throw new AppError('SERVICE_UNAVAILABLE');
    const name = parseName(input.name);
    const scopes = parseAccountApiKeyScopes(input.scopes);
    const scopeMask = accountApiKeyScopeMask(scopes);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const issued = this.tokens.issue();
      const keyPublicId = this.crypto.generatePublicIdV1();
      const result = await this.repository.issue({
        ownerUserPk: input.actor.ownerUserPk,
        keyPublicId,
        name,
        locator: issued.locator,
        tokenHash: issued.tokenHash,
        scopeMask,
        expiresAt: input.expiresAt,
        prefix: this.tokens.prefix(issued.locator),
        auditContext: auditContext(input.actor),
      });
      if (result.kind === 'collision') continue;
      if (result.kind === 'owner_disabled') throw new AppError('UNAUTHENTICATED');
      if (result.kind === 'invalid_expiry') throw new AppError('INVALID_PAYLOAD');
      if (result.kind === 'quota_exceeded') throw new AppError('RATE_LIMITED');
      return { apiKey: issued.token, metadata: result.metadata };
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async listMetadata(input: {
    actor: AccountApiKeyManagementActor;
    boundary: AccountApiKeyListBoundary | null;
    limit?: number | undefined;
    now: number;
  }): Promise<{ items: AccountApiKeyMetadata[]; nextBoundary: AccountApiKeyListBoundary | null }> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new AppError('INVALID_PAYLOAD');
    }
    return this.repository.list({
      ownerUserPk: input.actor.ownerUserPk,
      boundary: input.boundary,
      limit,
      prefixFromLocator: (locator) => this.tokens.prefix(locator),
      auditContext: auditContext(input.actor),
    });
  }

  async revoke(input: {
    actor: AccountApiKeyManagementActor;
    keyPublicId: string;
    now: number;
  }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.keyPublicId)) {
      throw new AppError('INVALID_PAYLOAD');
    }
    const result = await this.repository.revoke({
      ownerUserPk: input.actor.ownerUserPk,
      keyPublicId: input.keyPublicId,
      auditContext: auditContext(input.actor),
    });
    if (result.kind === 'not_found') throw new AppError('API_KEY_NOT_FOUND');
  }

  async resolveBearer(
    token: string,
    context: AccountApiKeyAuthenticationContext,
    _now?: number,
  ): Promise<ActiveAccountApiKeySnapshot> {
    if (!this.environment.accountApiKeyAuthEnabled) throw new AppError('UNAUTHENTICATED');
    let locator: Buffer;
    let locatorText: string;
    try {
      ({ locator, locatorText } = this.tokens.parse(token));
    } catch {
      const rateLimitFailure = await this.consumeMalformedFailure(context.clientIp);
      if (rateLimitFailure?.cached === true) throw rateLimitFailure.error;
      await this.repository.writeAuthenticationAudit({
        context: {
          correlationId: context.correlationId,
          ownerPublicId: null,
          sessionPublicId: null,
          actorPublicId: null,
        },
        result: {
          succeeded: false,
          keyPublicId: null,
          reason: 'malformed',
          subjectFingerprint: null,
        },
      });
      if (rateLimitFailure !== null) throw rateLimitFailure.error;
      throw new AppError('UNAUTHENTICATED');
    }
    const preflightFailure = this.preflightWellFormedFailure(locatorText, context.clientIp);
    if (preflightFailure !== null) throw preflightFailure.error;
    const credential = await this.repository.findCredential(locator);
    const presentedHash = this.tokens.hash(token);
    const hashMatches = this.crypto.constantTimeEqual(
      presentedHash,
      credential?.tokenHash ?? Buffer.alloc(32),
    );
    const reason =
      credential === null
        ? 'unknown'
        : !hashMatches
          ? 'invalid'
          : credential.ownerStatus !== 1
            ? 'owner_disabled'
            : credential.persistedStatus !== 1
              ? 'revoked'
              : credential.expiresAt <= credential.databaseNow
                ? 'expired'
                : null;
    if (reason !== null) {
      const rateLimitFailure = await this.consumeWellFormedFailure(locatorText, context.clientIp);
      if (rateLimitFailure?.cached === true) throw rateLimitFailure.error;
      await this.repository.writeAuthenticationAudit({
        context: {
          correlationId: context.correlationId,
          ownerPublicId: credential?.ownerPublicId ?? null,
          sessionPublicId: null,
          actorPublicId: credential?.keyPublicId ?? null,
        },
        result: {
          succeeded: false,
          keyPublicId: credential?.keyPublicId ?? null,
          reason,
          subjectFingerprint: this.crypto.hmac('audit-api-key-locator/v1', locatorText),
        },
      });
      if (rateLimitFailure !== null) throw rateLimitFailure.error;
      throw new AppError('UNAUTHENTICATED');
    }
    if (credential === null) throw new AppError('SERVICE_UNAVAILABLE');
    const snapshot: ActiveAccountApiKeySnapshot = {
      keyPk: credential.keyPk,
      keyPublicId: credential.keyPublicId,
      ownerUserPk: credential.ownerUserPk,
      ownerPublicId: credential.ownerPublicId,
      scopeMask: credential.scopeMask,
      scopes: accountApiKeyScopesFromMask(credential.scopeMask),
      expiresAt: credential.expiresAt,
    };
    await this.repository.writeAuthenticationAudit({
      context: {
        correlationId: context.correlationId,
        ownerPublicId: credential.ownerPublicId,
        sessionPublicId: null,
        actorPublicId: credential.keyPublicId,
      },
      result: { succeeded: true, keyPublicId: credential.keyPublicId },
    });
    void this.repository.markUsed(credential.keyPk).catch(() => {
      this.operationalLogger.warn({
        event: 'account_api_key_mark_used_failed',
        keyPublicId: credential.keyPublicId,
      });
    });
    return snapshot;
  }

  async recheckActive(
    connection: PoolConnection,
    snapshot: ActiveAccountApiKeySnapshot,
    _now: number,
  ): Promise<void> {
    let canonicalScopes: ActiveAccountApiKeySnapshot['scopes'];
    try {
      canonicalScopes = accountApiKeyScopesFromMask(snapshot.scopeMask);
    } catch {
      throw new AppError('UNAUTHENTICATED');
    }
    if (
      snapshot.scopes.length !== canonicalScopes.length ||
      snapshot.scopes.some((scope, index) => scope !== canonicalScopes[index])
    ) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (!(await this.repository.recheckActive(connection, snapshot))) {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  private async consumeMalformedFailure(clientIp: string): Promise<RateLimitFailure> {
    return this.consumeFailureBucket({
      surface: 'api-key-auth-failure-ip',
      purpose: 'rate-limit-ip/v1',
      identity: clientIp,
      limit: 60,
      windowMs: 5 * 60 * 1_000,
    });
  }

  private async consumeWellFormedFailure(
    locator: string,
    clientIp: string,
  ): Promise<RateLimitFailure> {
    const locatorFailure = await this.consumeFailureBucket({
      surface: 'api-key-auth-failure-locator',
      purpose: 'rate-limit-api-key/v1',
      identity: locator,
      limit: 20,
      windowMs: 5 * 60 * 1_000,
    });
    const ipFailure = await this.consumeMalformedFailure(clientIp);
    return locatorFailure ?? ipFailure;
  }

  private preflightWellFormedFailure(locator: string, clientIp: string): RateLimitFailure {
    return (
      this.saturatedFailure({
        surface: 'api-key-auth-failure-locator',
        purpose: 'rate-limit-api-key/v1',
        identity: locator,
        limit: 20,
        windowMs: 5 * 60 * 1_000,
      }) ??
      this.saturatedFailure({
        surface: 'api-key-auth-failure-ip',
        purpose: 'rate-limit-ip/v1',
        identity: clientIp,
        limit: 60,
        windowMs: 5 * 60 * 1_000,
      })
    );
  }

  private async consumeFailureBucket(
    bucket: AccountApiKeyFailureBucket,
  ): Promise<RateLimitFailure> {
    const saturated = this.saturatedFailure(bucket);
    if (saturated !== null) return saturated;
    try {
      await this.limiter.consume(bucket);
      return null;
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        this.rememberSaturatedFailure(bucket, error.retryAfterSeconds);
      }
      return { error, cached: false };
    }
  }

  private saturatedFailure(bucket: AccountApiKeyFailureBucket): RateLimitFailure {
    const cacheKey = this.failureBucketCacheKey(bucket);
    const expiresAt = this.saturatedFailureBuckets.get(cacheKey);
    if (expiresAt === undefined) return null;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      this.saturatedFailureBuckets.delete(cacheKey);
      return null;
    }
    return {
      error: new AppError('RATE_LIMITED', {
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
      }),
      cached: true,
    };
  }

  private rememberSaturatedFailure(
    bucket: AccountApiKeyFailureBucket,
    retryAfterSeconds: number | null,
  ): void {
    const cacheKey = this.failureBucketCacheKey(bucket);
    if (
      !this.saturatedFailureBuckets.has(cacheKey) &&
      this.saturatedFailureBuckets.size >= MAX_SATURATED_FAILURE_BUCKETS
    ) {
      const oldest = this.saturatedFailureBuckets.keys().next().value as string | undefined;
      if (oldest !== undefined) this.saturatedFailureBuckets.delete(oldest);
    }
    const durationMs = (retryAfterSeconds ?? Math.ceil(bucket.windowMs / 1_000)) * 1_000;
    this.saturatedFailureBuckets.set(cacheKey, Date.now() + durationMs);
  }

  private failureBucketCacheKey(bucket: AccountApiKeyFailureBucket): string {
    return `${bucket.surface}:${this.crypto.hmac(bucket.purpose, bucket.identity).toString('base64url')}`;
  }
}
