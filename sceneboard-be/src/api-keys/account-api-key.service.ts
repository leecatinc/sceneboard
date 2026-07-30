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

const DAY_MS = 24 * 60 * 60 * 1_000;

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

const parseExpiry = (value: number | undefined, now: number): number => {
  const expiresAt = value ?? now + 90 * DAY_MS;
  const duration = expiresAt - now;
  if (!Number.isSafeInteger(expiresAt) || duration < DAY_MS || duration > 365 * DAY_MS) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return expiresAt;
};

const auditContext = (actor: AccountApiKeyManagementActor): AccountApiKeyAuditContext => ({
  correlationId: actor.correlationId,
  ownerPublicId: actor.ownerPublicId,
  sessionPublicId: actor.sessionPublicId,
  actorPublicId: actor.ownerPublicId,
});

export class AccountApiKeyService {
  constructor(
    private readonly repository: AccountApiKeyRepository,
    private readonly tokens: AccountApiKeyTokenCodec,
    private readonly crypto: CryptoService,
    private readonly limiter: RateLimitService,
    private readonly environment: Pick<
      AppEnvironment,
      'accountApiKeyIssuanceEnabled' | 'accountApiKeyAuthEnabled'
    >,
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
    const expiresAt = parseExpiry(input.expiresAt, input.now);
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
        expiresAt,
        now: input.now,
        prefix: this.tokens.prefix(issued.locator),
        auditContext: auditContext(input.actor),
      });
      if (result.kind === 'collision') continue;
      if (result.kind === 'owner_disabled') throw new AppError('UNAUTHENTICATED');
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
      now: input.now,
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
      now: input.now,
      auditContext: auditContext(input.actor),
    });
    if (result.kind === 'not_found') throw new AppError('API_KEY_NOT_FOUND');
  }

  async resolveBearer(
    token: string,
    context: AccountApiKeyAuthenticationContext,
    now: number,
  ): Promise<ActiveAccountApiKeySnapshot> {
    if (!this.environment.accountApiKeyAuthEnabled) throw new AppError('UNAUTHENTICATED');
    let locator: Buffer;
    let locatorText: string;
    try {
      ({ locator, locatorText } = this.tokens.parse(token));
    } catch {
      await this.consumeMalformedFailure(context.clientIp);
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
      throw new AppError('UNAUTHENTICATED');
    }
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
              : credential.expiresAt <= now
                ? 'expired'
                : null;
    if (reason !== null) {
      await this.consumeWellFormedFailure(locatorText, context.clientIp);
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
          subjectFingerprint: this.crypto.hmac('rate-limit-api-key/v1', locatorText),
        },
      });
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
    void this.repository.markUsed(credential.keyPk, now).catch(() => undefined);
    return snapshot;
  }

  async recheckActive(
    connection: PoolConnection,
    snapshot: ActiveAccountApiKeySnapshot,
    now: number,
  ): Promise<void> {
    if (!(await this.repository.recheckActive(connection, snapshot, now))) {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  private async consumeMalformedFailure(clientIp: string): Promise<void> {
    await this.limiter.consume({
      surface: 'api-key-auth-failure-ip',
      purpose: 'rate-limit-ip/v1',
      identity: clientIp,
      limit: 60,
      windowMs: 5 * 60 * 1_000,
    });
  }

  private async consumeWellFormedFailure(locator: string, clientIp: string): Promise<void> {
    await this.limiter.consume({
      surface: 'api-key-auth-failure-locator',
      purpose: 'rate-limit-api-key/v1',
      identity: locator,
      limit: 20,
      windowMs: 5 * 60 * 1_000,
    });
    await this.consumeMalformedFailure(clientIp);
  }
}
