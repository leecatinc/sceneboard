import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import { resolveClientIp } from '../common/security/client-ip.js';
import { RateLimitService } from './rate-limit.service.js';

export const BoardOperationRateLimitPolicy = {
  'board-read': { pre: [1_000, 300_000], post: [600, 300_000] },
  'capability-negotiation': { pre: [300, 300_000], post: [120, 300_000] },
  'board-mutation': { pre: [1_000, 300_000], post: [120, 300_000] },
  'board-create': { pre: [300, 3_600_000], post: [20, 3_600_000] },
  'board-archive': { pre: [300, 3_600_000], post: [30, 3_600_000] },
} as const;

export type BoardOperationRateLimitClass = keyof typeof BoardOperationRateLimitPolicy;

const ACCOUNT_API_KEY_OPERATION_LIMITS = {
  'board-read': {
    key: ['api-key-op-board-read-key', 600, 300_000],
    account: ['api-key-op-board-read-account', 600, 300_000],
    ip: ['api-key-op-board-read-ip', 1_000, 300_000],
  },
  'capability-negotiation': {
    key: ['api-key-op-capability-key', 120, 300_000],
    account: ['api-key-op-capability-account', 120, 300_000],
    ip: ['api-key-op-capability-ip', 300, 300_000],
  },
  'board-mutation': {
    key: ['api-key-op-mutation-key', 120, 300_000],
    account: ['api-key-op-mutation-account', 120, 300_000],
    ip: ['api-key-op-mutation-ip', 1_000, 300_000],
  },
  'board-create': {
    key: ['api-key-op-create-key', 20, 3_600_000],
    account: ['api-key-op-create-account', 20, 3_600_000],
    ip: ['api-key-op-create-ip', 300, 3_600_000],
  },
  'board-archive': {
    key: ['api-key-op-archive-key', 30, 3_600_000],
    account: ['api-key-op-archive-account', 30, 3_600_000],
    ip: ['api-key-op-archive-ip', 300, 3_600_000],
  },
} as const satisfies Readonly<
  Record<
    BoardOperationRateLimitClass,
    Readonly<
      Record<'key' | 'account' | 'ip', readonly [surface: string, limit: number, windowMs: number]>
    >
  >
>;

const BOARD_OPERATION_RATE_LIMIT_CLASS = Symbol('BOARD_OPERATION_RATE_LIMIT_CLASS');

export const BoardOperationRateLimited = (
  operationClass: BoardOperationRateLimitClass,
): MethodDecorator => SetMetadata(BOARD_OPERATION_RATE_LIMIT_CLASS, operationClass);

interface BoardOperationRateLimitRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
}

@Injectable()
export class BoardOperationRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const operationClass = this.reflector.getAllAndOverride<
      BoardOperationRateLimitClass | undefined
    >(BOARD_OPERATION_RATE_LIMIT_CLASS, [context.getHandler(), context.getClass()]);
    if (operationClass === undefined) return true;
    const request = context.switchToHttp().getRequest<BoardOperationRateLimitRequest>();
    if (request.boardPrincipal?.kind !== 'account_api_key') return true;
    const snapshot = request.boardPrincipal[ACCOUNT_API_KEY_SNAPSHOT];
    const forwarded = request.headers['x-forwarded-for'];
    const clientIp = resolveClientIp({
      socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
      xForwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
      trustedProxyCidrs: this.environment.trustedProxyCidrs,
    }).address;
    const policy = ACCOUNT_API_KEY_OPERATION_LIMITS[operationClass];
    await this.consume(policy.key, 'rate-limit-api-key/v1', snapshot.keyPublicId);
    await this.consume(policy.account, 'rate-limit-user/v1', snapshot.ownerPublicId);
    await this.consume(policy.ip, 'rate-limit-ip/v1', clientIp);
    return true;
  }

  private async consume(
    policy: readonly [surface: string, limit: number, windowMs: number],
    purpose: 'rate-limit-api-key/v1' | 'rate-limit-user/v1' | 'rate-limit-ip/v1',
    identity: string,
  ): Promise<void> {
    await this.limiter.consume({
      surface: policy[0],
      purpose,
      identity,
      limit: policy[1],
      windowMs: policy[2],
    });
  }
}
