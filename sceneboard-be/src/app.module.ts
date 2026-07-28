import cookieParser from 'cookie-parser';
import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { HttpErrorFilter } from './common/filters/http-error.filter.js';
import { ResponseHeadersInterceptor } from './common/http/response-headers.interceptor.js';
import { StrictJsonBodyMiddleware } from './common/http/strict-json-body.middleware.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { OriginGuard } from './common/guards/origin.guard.js';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import {
  D2PostAuthRateLimitGuard,
  D2PreAuthRateLimitGuard,
} from './rate-limit/d2-rate-limit.guards.js';
import { SceneBoardConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RedisModule } from './redis/redis.module.js';
import { PairingModule } from './pairing/pairing.module.js';
import { PairingProofGuard } from './common/guards/pairing-proof.guard.js';
import { GrantModule } from './grants/grant.module.js';
import { BoardModule } from './boards/board.module.js';
import { BoardPrincipalGuard } from './common/guards/board-principal.guard.js';
import { EventsModule } from './events/events.module.js';
import { SseModule } from './sse/sse.module.js';
import { StreamAdmissionGuard } from './sse/stream-admission.guard.js';
import { CorsPolicyMiddleware } from './common/http/cors-policy.middleware.js';
import { PresenceModule } from './presence/presence.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { PersistenceCertificationModule } from './bootstrap/persistence-certification.module.js';
import { InvitationModule } from './invitations/invitation.module.js';
import { ShareModule } from './shares/share.module.js';

@Module({
  imports: [
    SceneBoardConfigModule,
    DatabaseModule,
    PersistenceCertificationModule,
    RedisModule,
    AuditModule,
    AuthModule,
    RateLimitModule,
    PairingModule,
    GrantModule,
    BoardModule,
    EventsModule,
    PresenceModule,
    McpModule,
    SseModule,
    InvitationModule,
    ShareModule,
  ],
  providers: [
    StrictJsonBodyMiddleware,
    CorsPolicyMiddleware,
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseHeadersInterceptor },
    { provide: APP_GUARD, useClass: StreamAdmissionGuard },
    { provide: APP_GUARD, useClass: D2PreAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: BoardPrincipalGuard },
    { provide: APP_GUARD, useClass: PairingProofGuard },
    { provide: APP_GUARD, useClass: D2PostAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorsPolicyMiddleware, StrictJsonBodyMiddleware, cookieParser())
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
