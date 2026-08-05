import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  ShareIdempotencyKeyParserV1,
  SharePasswordSuccessParserV1,
  SharePublishRequestParserV1,
  ShareUpdateRequestParserV1,
  ShareVersionRequestParserV1,
  type BoardId,
  type RevisionId,
} from '@sceneboard/board-schema';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError, ShareContractError } from '../common/errors/app-error.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { SharePublicationService } from './share-publication.service.js';
import { PasswordShareService } from './password-share.service.js';

type ShareRequest = BoardPrincipalRequest & {
  authSession?: SessionRecord | undefined;
};

interface ShareResponse {
  status(code: number): ShareResponse;
}

const boardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
  return parsed.data.value;
};

const globalId = (value: string): string => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
  return parsed.data.value;
};

const idempotencyKey = (value: string | undefined): string => {
  const parsed = ShareIdempotencyKeyParserV1.parse(value);
  if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
  return parsed.data.value;
};

const ownerContext = (
  request: ShareRequest,
  rawBoardId: string,
): {
  principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
  session: SessionRecord;
  boardId: BoardId;
} => {
  if (request.boardPrincipal?.kind !== 'user' || request.authSession === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  return {
    principal: request.boardPrincipal,
    session: request.authSession,
    boardId: boardId(rawBoardId),
  };
};

@Controller('api/v1/boards')
@RequireBoardPrincipal()
export class ShareController {
  constructor(
    @Inject(SharePublicationService) private readonly shares: SharePublicationService,
    @Inject(PasswordShareService) private readonly passwords: PasswordShareService,
  ) {}

  @Get(':boardId/shares')
  async list(@Req() request: ShareRequest, @Param('boardId') rawBoardId: string) {
    return this.shares.list(ownerContext(request, rawBoardId));
  }

  @Post(':boardId/shares')
  @RequireCsrf('session')
  async publish(
    @Req() request: ShareRequest,
    @Res({ passthrough: true }) response: ShareResponse,
    @Param('boardId') rawBoardId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = SharePublishRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST');
    const result = await this.shares.publish({
      ...ownerContext(request, rawBoardId),
      pinnedRevisionId: body.data.value.pinnedRevisionId,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
    response.status(result.replayed ? 200 : 201);
    return result.value;
  }

  @Patch(':boardId/shares/:shareId')
  @RequireCsrf('session')
  async update(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = ShareUpdateRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST');
    return this.shares.update({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      pinnedRevisionId: body.data.value.pinnedRevisionId as RevisionId,
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
  }

  @Post(':boardId/shares/:shareId/rotate-link')
  @HttpCode(200)
  @RequireCsrf('session')
  async rotate(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = ShareVersionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST');
    const result = await this.shares.rotate({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
    return result.value;
  }

  @Delete(':boardId/shares/:shareId')
  @HttpCode(204)
  @RequireCsrf('session')
  async revoke(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const body = ShareVersionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST');
    await this.shares.revoke({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
  }

  @Post(':boardId/shares/:shareId/password')
  @HttpCode(200)
  @RequireCsrf('session')
  async enablePassword(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = ShareVersionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
    return this.passwords.enable({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
  }

  @Post(':boardId/shares/:shareId/password/regenerate')
  @HttpCode(200)
  @RequireCsrf('session')
  async regeneratePassword(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = ShareVersionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
    const result = await this.passwords.regenerate({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
    if ('password' in result) {
      const parsed = SharePasswordSuccessParserV1.parse(result);
      if (!parsed.ok) throw new ShareContractError('SHARE_PASSWORD_STATE_CONFLICT');
    }
    return result;
  }

  @Delete(':boardId/shares/:shareId/password')
  @HttpCode(204)
  @RequireCsrf('session')
  async disablePassword(
    @Req() request: ShareRequest,
    @Param('boardId') rawBoardId: string,
    @Param('shareId') rawShareId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const body = ShareVersionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
    await this.passwords.disable({
      ...ownerContext(request, rawBoardId),
      shareId: globalId(rawShareId),
      expectedVersion: body.data.value.expectedVersion,
      idempotencyKey: idempotencyKey(rawIdempotencyKey),
    });
  }
}
