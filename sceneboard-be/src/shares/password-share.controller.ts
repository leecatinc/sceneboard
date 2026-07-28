import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { SharePasswordAdmissionRequestParserV1 } from '@sceneboard/board-schema';

import { ShareContractError } from '../common/errors/app-error.js';
import { assertAllowedOrigin } from '../common/guards/origin.guard.js';
import { resolveClientIp } from '../common/security/client-ip.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { PasswordShareService } from './password-share.service.js';
import { ShareCookieService } from './share-cookie.service.js';

interface PublicPasswordRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

interface PublicPasswordResponse {
  setHeader(name: string, value: string | readonly string[]): unknown;
}

const oneHeader = (request: PublicPasswordRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

@Controller('api/v1/public/shares')
export class PasswordShareController {
  constructor(
    @Inject(PasswordShareService) private readonly passwords: PasswordShareService,
    @Inject(ShareCookieService) private readonly cookies: ShareCookieService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  @Post(':shareToken/password-sessions')
  @HttpCode(204)
  async admit(
    @Req() request: PublicPasswordRequest,
    @Res({ passthrough: true }) response: PublicPasswordResponse,
    @Param('shareToken') shareToken: string,
    @Headers('x-sceneboard-share-csrf') csrfHeader: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const hostname = new URL(this.environment.browserOrigin).hostname;
    try {
      assertAllowedOrigin(oneHeader(request, 'origin'), this.environment.browserOrigin);
      this.cookies.assertCsrf({
        hostname,
        cookieHeader: oneHeader(request, 'cookie'),
        header: csrfHeader,
        nowSeconds: Math.floor(Date.now() / 1_000),
      });
    } catch (error) {
      response.setHeader('Set-Cookie', this.cookies.clearCsrf(hostname));
      if (error instanceof ShareContractError) throw error;
      throw new ShareContractError('INVALID_REQUEST', null, 'csrf');
    }
    const body = SharePasswordAdmissionRequestParserV1.parse(rawBody);
    if (!body.ok) throw new ShareContractError('INVALID_REQUEST', null, 'body');
    const forwarded = oneHeader(request, 'x-forwarded-for');
    const ip = resolveClientIp({
      socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
      xForwardedFor: forwarded,
      trustedProxyCidrs: this.environment.trustedProxyCidrs,
      maximumForwardedEntries: 32,
    }).address;
    const result = await this.passwords.admit({
      shareToken,
      password: body.data.value.password,
      ip,
      hostname,
      familyToken: this.cookies.familyFromHeader(oneHeader(request, 'cookie'), hostname),
    });
    if (result.setCookie !== null) response.setHeader('Set-Cookie', result.setCookie);
  }
}
