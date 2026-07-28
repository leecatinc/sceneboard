import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  PrincipalIdParserV1,
  type BoardId,
  type InvitationRoleV1,
} from '@sceneboard/board-schema';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError } from '../common/errors/app-error.js';
import { RequireSession } from '../common/guards/authentication.guard.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { resolveClientIp } from '../common/security/client-ip.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { InvitationService } from './invitation.service.js';

type InvitationRequest = BoardPrincipalRequest & {
  authSession?: SessionRecord | undefined;
  body?: unknown;
  query?: unknown;
  socket?: { remoteAddress?: string | undefined } | undefined;
};

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_PAYLOAD');
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AppError('INVALID_PAYLOAD');
  }
};

const parseBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new AppError('INVALID_PAYLOAD');
  return parsed.data.value;
};

const parseGlobalId = (value: string): string => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new AppError('INVALID_PAYLOAD');
  return parsed.data.value;
};

const parsePrincipalId = (value: unknown): string => {
  const parsed = PrincipalIdParserV1.parse(value);
  if (!parsed.ok) throw new AppError('INVALID_PAYLOAD');
  return parsed.data.value;
};

const parseRole = (value: unknown): InvitationRoleV1 => {
  if (value !== 'editor' && value !== 'viewer') throw new AppError('INVALID_PAYLOAD');
  return value;
};

const parseVersion = (value: unknown): number => {
  const parsed =
    typeof value === 'string' && /^[1-9][0-9]{0,15}$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1)
    throw new AppError('INVALID_PAYLOAD');
  return parsed as number;
};

const ownerContext = (
  request: InvitationRequest,
  boardId: string,
  environment: AppEnvironment,
): {
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  session: SessionRecord;
  boardId: BoardId;
  ip: string;
} => {
  if (request.boardPrincipal?.kind !== 'user' || request.authSession === undefined)
    throw new AppError('UNAUTHENTICATED');
  return {
    principal: request.boardPrincipal,
    session: request.authSession,
    boardId: parseBoardId(boardId),
    ip: clientIp(request, environment),
  };
};

const clientIp = (request: InvitationRequest, environment: AppEnvironment): string => {
  const forwarded = request.headers['x-forwarded-for'];
  return resolveClientIp({
    socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
    xForwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
    trustedProxyCidrs: environment.trustedProxyCidrs,
  }).address;
};

@Controller('api/v1/boards')
@RequireBoardPrincipal()
export class BoardInvitationController {
  constructor(
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  @Get(':boardId/members')
  async listManagedAccess(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Query() queryValue: unknown,
  ) {
    exactKeys(record(queryValue), []);
    return this.invitations.listManagedAccess(ownerContext(request, boardId, this.environment));
  }

  @Get(':boardId/member-candidates')
  async search(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Query() queryValue: unknown,
  ) {
    const query = record(queryValue);
    exactKeys(query, ['q']);
    if (typeof query.q !== 'string') throw new AppError('INVALID_PAYLOAD');
    return this.invitations.searchCandidates({
      ...ownerContext(request, boardId, this.environment),
      query: query.q,
    });
  }

  @Post(':boardId/invitations')
  @HttpCode(201)
  @RequireCsrf('session')
  async issue(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Body() bodyValue: unknown,
  ) {
    const body = record(bodyValue);
    const hasEmail = Object.hasOwn(body, 'email');
    exactKeys(body, hasEmail ? ['email', 'role'] : ['accountId', 'role']);
    if (
      (hasEmail && typeof body.email !== 'string') ||
      (!hasEmail && typeof body.accountId !== 'string')
    ) {
      throw new AppError('INVALID_PAYLOAD');
    }
    return this.invitations.issue({
      ...ownerContext(request, boardId, this.environment),
      ...(hasEmail
        ? { email: body.email as string }
        : { accountId: parsePrincipalId(body.accountId) }),
      role: parseRole(body.role),
    });
  }

  @Post(':boardId/invitations/:inviteId/resend')
  @HttpCode(201)
  @RequireCsrf('session')
  async resend(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Param('inviteId') inviteId: string,
    @Body() bodyValue: unknown,
  ) {
    exactKeys(record(bodyValue), []);
    return this.invitations.resend({
      ...ownerContext(request, boardId, this.environment),
      inviteId: parseGlobalId(inviteId),
    });
  }

  @Delete(':boardId/invitations/:inviteId')
  @HttpCode(204)
  @RequireCsrf('session')
  async revoke(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    await this.invitations.revoke({
      ...ownerContext(request, boardId, this.environment),
      inviteId: parseGlobalId(inviteId),
    });
  }

  @Patch(':boardId/members/:memberId')
  @RequireCsrf('session')
  async updateMember(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Param('memberId') memberId: string,
    @Body() bodyValue: unknown,
  ) {
    const body = record(bodyValue);
    exactKeys(body, ['role', 'version']);
    return this.invitations.updateMember({
      ...ownerContext(request, boardId, this.environment),
      memberId: parseGlobalId(memberId),
      role: parseRole(body.role),
      version: parseVersion(body.version),
    });
  }

  @Delete(':boardId/members/:memberId')
  @HttpCode(204)
  @RequireCsrf('session')
  async removeMember(
    @Req() request: InvitationRequest,
    @Param('boardId') boardId: string,
    @Param('memberId') memberId: string,
    @Query() queryValue: unknown,
  ): Promise<void> {
    const query = record(queryValue);
    exactKeys(query, ['version']);
    await this.invitations.removeMember({
      ...ownerContext(request, boardId, this.environment),
      memberId: parseGlobalId(memberId),
      version: parseVersion(query.version),
    });
  }
}

@Controller('api/v1/invitations')
@RequireSession()
export class InvitationAcceptanceController {
  constructor(
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  @Post(':token/accept')
  @RequireCsrf('session')
  async accept(
    @Req() request: InvitationRequest,
    @Param('token') token: string,
    @Body() bodyValue: unknown,
  ) {
    exactKeys(record(bodyValue), []);
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.invitations.accept({
      token,
      session: request.authSession,
      ip: clientIp(request, this.environment),
    });
  }
}
