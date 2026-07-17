import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlTransactionRunner } from '../database/mysql-transaction.runner.js';
import { AuthController, AUTH_CONTROLLER_SERVICE } from './auth.controller.js';
import { AuthPersistenceService } from './auth.persistence.js';
import { AuthService } from './auth.service.js';
import { CookieService } from './cookie.service.js';
import { CsrfService } from './csrf.service.js';
import { PasswordService } from './password.service.js';
import { SessionTokenService } from './session-token.service.js';
import { SessionService } from './session.service.js';
import { LogoutService } from './logout.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { UsersRepository } from './users.repository.js';
import { SceneBoardConfigModule } from '../config/config.module.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { GmailMailerService } from './gmail-mailer.service.js';
import { PasswordChangeRepository } from './password-change.repository.js';
import { PasswordChangeService } from './password-change.service.js';

@Module({
  imports: [SceneBoardConfigModule, DatabaseModule, AuditModule, RateLimitModule],
  controllers: [AuthController],
  providers: [
    UsersRepository,
    SessionsRepository,
    PasswordChangeRepository,
    {
      provide: PasswordService,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => new PasswordService(
        environment.bcryptCost,
        environment.authFailureMinMs,
        environment.authFailureJitterMs,
      ),
    },
    {
      provide: SessionTokenService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new SessionTokenService(crypto),
    },
    {
      provide: CsrfService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new CsrfService(crypto),
    },
    {
      provide: SessionService,
      inject: [SessionsRepository, SessionTokenService, CsrfService, CryptoService, RateLimitService],
      useFactory: (
        sessions: SessionsRepository,
        sessionTokens: SessionTokenService,
        csrf: CsrfService,
        crypto: CryptoService,
        limiter: RateLimitService,
      ) => new SessionService(sessions, sessionTokens, csrf, crypto, limiter),
    },
    {
      provide: CookieService,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => new CookieService(environment.appEnv),
    },
    {
      provide: LogoutService,
      inject: [SessionsRepository, SessionTokenService, CsrfService],
      useFactory: (
        sessions: SessionsRepository,
        sessionTokens: SessionTokenService,
        csrf: CsrfService,
      ) => new LogoutService(sessions, sessionTokens, csrf),
    },
    {
      provide: AuthPersistenceService,
      inject: [MysqlTransactionRunner, UsersRepository, SessionsRepository, AuditRepository],
      useFactory: (
        transactions: MysqlTransactionRunner,
        users: UsersRepository,
        sessions: SessionsRepository,
        audit: AuditRepository,
      ) => new AuthPersistenceService(transactions, users, sessions, audit),
    },
    {
      provide: GmailMailerService,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => new GmailMailerService(environment.gmail),
    },
    {
      provide: EmailVerificationService,
      inject: [RedisService, CryptoService, GmailMailerService, APP_ENVIRONMENT],
      useFactory: (
        redis: RedisService,
        crypto: CryptoService,
        mailer: GmailMailerService,
        environment: AppEnvironment,
      ) => new EmailVerificationService(redis, crypto, mailer, environment.redis.keyPrefix),
    },
    {
      provide: AuthService,
      inject: [AuthPersistenceService, PasswordService, SessionTokenService, CsrfService, CryptoService],
      useFactory: (
        persistence: AuthPersistenceService,
        passwords: PasswordService,
        sessionTokens: SessionTokenService,
        csrf: CsrfService,
        crypto: CryptoService,
      ) => new AuthService(persistence, passwords, sessionTokens, csrf, crypto),
    },
    {
      provide: PasswordChangeService,
      inject: [PasswordChangeRepository, PasswordService],
      useFactory: (
        persistence: PasswordChangeRepository,
        passwords: PasswordService,
      ) => new PasswordChangeService(persistence, passwords),
    },
    { provide: AUTH_CONTROLLER_SERVICE, useExisting: AuthService },
  ],
  exports: [CsrfService, CookieService, AuthService, SessionService, LogoutService, EmailVerificationService, PasswordChangeService],
})
export class AuthModule {}
