import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError } from '../common/errors/app-error.js';
import { RequireSession } from '../common/guards/authentication.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { RequireOrigin } from '../common/guards/origin.guard.js';
import { resolveClientIp } from '../common/security/client-ip.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { parseAccountApiKeyCreateDto, parseAccountApiKeyId } from './account-api-key.dto.js';
import { AccountApiKeyListCursorCodec } from './account-api-key-list-cursor.codec.js';
import type { AccountApiKeyMetadata } from './account-api-key.repository.js';
import { AccountApiKeyService } from './account-api-key.service.js';

interface AccountApiKeyRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  authSession?: SessionRecord | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

const limit = (value: unknown): number => {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/u.test(value)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  const parsed = Number(value);
  if (parsed > 50) throw new AppError('INVALID_PAYLOAD');
  return parsed;
};

const query = (value: unknown): { limit: number; cursor: string | null } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_PAYLOAD');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== 'limit' && key !== 'cursor'))
    throw new AppError('INVALID_PAYLOAD');
  if (
    source.cursor !== undefined &&
    (typeof source.cursor !== 'string' || source.cursor.length === 0)
  )
    throw new AppError('INVALID_PAYLOAD');
  return { limit: limit(source.limit), cursor: (source.cursor as string | undefined) ?? null };
};

@Controller('api/v1/account/api-keys')
@RequireSession()
export class AccountApiKeyController {
  constructor(
    @Inject(AccountApiKeyService) private readonly apiKeys: AccountApiKeyService,
    @Inject(AccountApiKeyListCursorCodec) private readonly cursors: AccountApiKeyListCursorCodec,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireOrigin()
  @RequireCsrf('session')
  async create(@Req() request: AccountApiKeyRequest): Promise<{
    apiKey: string;
    metadata: AccountApiKeyMetadata;
  }> {
    const session = this.session(request);
    const now = Date.now();
    const actor = this.actor(request, session);
    await this.apiKeys.consumeManagementLimits('issue', actor);
    const input = parseAccountApiKeyCreateDto(request.body);
    return this.apiKeys.issue({
      actor,
      name: input.displayName,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      now,
    });
  }

  @Get()
  @HttpCode(200)
  @RequireOrigin()
  @RequireCsrf('session')
  async list(
    @Query() input: unknown,
    @Req() request: AccountApiKeyRequest,
  ): Promise<{
    items: AccountApiKeyMetadata[];
    nextCursor: string | null;
  }> {
    const session = this.session(request);
    const now = Date.now();
    const actor = this.actor(request, session);
    await this.apiKeys.consumeManagementLimits('list', actor);
    const parsed = query(input);
    const boundary =
      parsed.cursor === null
        ? null
        : this.cursors.parse({
            cursor: parsed.cursor,
            ownerUserPk: session.user.databaseId,
            now,
          });
    const result = await this.apiKeys.listMetadata({
      actor,
      boundary,
      limit: parsed.limit,
      now,
    });
    return {
      items: result.items,
      nextCursor:
        result.nextBoundary === null
          ? null
          : this.cursors.issue({
              ownerUserPk: session.user.databaseId,
              boundary: result.nextBoundary,
              now,
            }),
    };
  }

  @Delete(':apiKeyId')
  @HttpCode(204)
  @RequireOrigin()
  @RequireCsrf('session')
  async revoke(
    @Param('apiKeyId') apiKeyId: string,
    @Req() request: AccountApiKeyRequest,
  ): Promise<void> {
    const session = this.session(request);
    const actor = this.actor(request, session);
    await this.apiKeys.consumeManagementLimits('revoke', actor);
    await this.apiKeys.revoke({
      actor,
      keyPublicId: parseAccountApiKeyId(apiKeyId),
      now: Date.now(),
    });
  }

  private session(request: AccountApiKeyRequest): SessionRecord {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return request.authSession;
  }

  private actor(request: AccountApiKeyRequest, session: SessionRecord) {
    const forwarded = request.headers['x-forwarded-for'];
    return {
      ownerUserPk: session.user.databaseId,
      ownerPublicId: session.user.publicId,
      sessionPublicId: session.publicId,
      correlationId: this.crypto.generatePublicIdV1(),
      clientIp: resolveClientIp({
        socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
        xForwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
        trustedProxyCidrs: this.environment.trustedProxyCidrs,
      }).address,
    };
  }
}
