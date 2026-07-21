import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { parseEmptyObject } from '../auth/auth.dto.js';
import { AppError } from '../common/errors/app-error.js';
import {
  RequireSession,
  type AuthenticatedRequest,
} from '../common/guards/authentication.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import { parseGrantListQuery } from './grant.dto.js';
import { GrantService } from './grant.service.js';
import type { GrantCredentialResponse, GrantSummary } from './grant.status.js';

@Controller('api/v1/grants')
export class GrantController {
  constructor(@Inject(GrantService) private readonly grants: GrantService) {}

  @Get()
  @RequireSession()
  async list(
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<{ grants: GrantSummary[]; nextCursor: string | null }> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.grants.list(request.authSession, parseGrantListQuery(query), now);
  }

  @Delete(':grantId')
  @HttpCode(204)
  @RequireSession()
  @RequireCsrf('session')
  async revoke(
    @Param('grantId') grantId: string,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<void> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.grants.revoke(request.authSession, grantId, now);
  }

  @Post(':grantId/rotate')
  @HttpCode(200)
  @RequireSession()
  @RequireCsrf('session')
  @D2RateLimited('grant-rotate')
  async rotate(
    @Param('grantId') grantId: string,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<GrantCredentialResponse> {
    parseEmptyObject((request as AuthenticatedRequest & { body?: unknown }).body);
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.grants.rotate(request.authSession, grantId, now);
  }
}
