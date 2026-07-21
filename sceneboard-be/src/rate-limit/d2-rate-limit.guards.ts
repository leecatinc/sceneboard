import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  parseAuthCredentials,
  parseEmailVerificationConfirmation,
  parseEmailVerificationRequest,
  parseEmptyObject,
  parsePasswordChangeRequest,
  parseSignupCredentials,
} from '../auth/auth.dto.js';
import { parsePairingClaim, parsePairingDecision } from '../pairing/pairing.dto.js';
import { maskClientIpPrefix, resolveClientIp } from '../common/security/client-ip.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { RateLimitService } from './rate-limit.service.js';
import { parseGrantId, parsePairingId } from '../common/ids/public-id.js';
import type { PairingProofRequest } from '../common/guards/pairing-proof.guard.js';

type D2RateLimitedSurface =
  | 'csrf-bootstrap'
  | 'signup'
  | 'login'
  | 'email-verification-request'
  | 'email-verification-confirm'
  | 'password-change'
  | 'session-renewal'
  | 'pairing-create'
  | 'pairing-claim'
  | 'pairing-decision'
  | 'pairing-client-status'
  | 'pairing-redeem'
  | 'grant-rotate';
const D2_RATE_LIMITED_SURFACE = Symbol('D2_RATE_LIMITED_SURFACE');

export const D2RateLimited = (surface: D2RateLimitedSurface): MethodDecorator =>
  SetMetadata(D2_RATE_LIMITED_SURFACE, surface);

interface RateLimitedRequest extends PairingProofRequest {
  body?: unknown;
  params?: Record<string, string | undefined> | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

const surfaceOf = (
  reflector: Reflector,
  context: ExecutionContext,
): D2RateLimitedSurface | undefined =>
  reflector.getAllAndOverride<D2RateLimitedSurface | undefined>(D2_RATE_LIMITED_SURFACE, [
    context.getHandler(),
    context.getClass(),
  ]);

@Injectable()
export class D2PreAuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const surface = surfaceOf(this.reflector, context);
    if (surface === undefined) return true;
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    let emailIdentity: string | null = null;
    if (surface === 'csrf-bootstrap') {
      // The no-body transport profile has already rejected any streamed bytes.
    } else if (surface === 'signup') {
      emailIdentity = parseSignupCredentials(request.body).emailNormalized;
    } else if (surface === 'login') {
      emailIdentity = parseAuthCredentials(request.body).emailNormalized;
    } else if (surface === 'email-verification-request') {
      emailIdentity = parseEmailVerificationRequest(request.body).emailNormalized;
    } else if (surface === 'email-verification-confirm') {
      emailIdentity = parseEmailVerificationConfirmation(request.body).emailNormalized;
    } else if (surface === 'password-change') {
      parsePasswordChangeRequest(request.body);
    } else if (surface === 'session-renewal' || surface === 'pairing-create')
      parseEmptyObject(request.body);
    else if (surface === 'pairing-claim') parsePairingClaim(request.body);
    else if (surface === 'pairing-decision') parsePairingDecision(request.body);
    else if (surface === 'pairing-client-status' || surface === 'pairing-redeem') {
      parsePairingId(request.params?.pairingId);
      if (surface === 'pairing-redeem') parseEmptyObject(request.body);
    } else {
      parseGrantId(request.params?.grantId);
      parseEmptyObject(request.body);
    }
    const forwarded = request.headers['x-forwarded-for'];
    const client = resolveClientIp({
      socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
      xForwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
      trustedProxyCidrs: this.environment.trustedProxyCidrs,
    });
    const ipPolicy = preAuthPolicy(surface);
    await this.limiter.consume({
      surface,
      purpose: 'rate-limit-ip/v1',
      identity: maskClientIpPrefix(client.address),
      limit: ipPolicy.limit,
      windowMs: ipPolicy.windowMs,
      ...(surface === 'csrf-bootstrap' ? { unavailableRetryAfterSeconds: 5 } : {}),
    });
    if (emailIdentity !== null) {
      await this.limiter.consume({
        surface: `${surface}-email`,
        purpose: 'rate-limit-email/v1',
        identity: emailIdentity,
        limit: surface === 'signup' || surface === 'email-verification-request' ? 3 : 5,
        windowMs:
          surface === 'signup' || surface === 'email-verification-request'
            ? 60 * 60 * 1_000
            : 15 * 60 * 1_000,
      });
    }
    return true;
  }
}

@Injectable()
export class D2PostAuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const surface = surfaceOf(this.reflector, context);
    if (surface === undefined) return true;
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    if (
      surface === 'csrf-bootstrap' ||
      surface === 'signup' ||
      surface === 'login' ||
      surface === 'email-verification-request' ||
      surface === 'email-verification-confirm' ||
      surface === 'session-renewal'
    ) {
      return true;
    }
    if (surface === 'pairing-client-status' || surface === 'pairing-redeem') {
      const pairingId = parsePairingId(request.params?.pairingId);
      const fingerprint = request.pairingProof?.rateLimitFingerprint;
      if (fingerprint === undefined) return true;
      await this.limiter.consume({
        surface: `${surface}-proof`,
        purpose: 'rate-limit-pairing/v1',
        identity: `${pairingId}\u0000${fingerprint}`,
        limit: surface === 'pairing-client-status' ? 120 : 10,
        windowMs: 5 * 60 * 1_000,
      });
      return true;
    }
    if (surface === 'grant-rotate') {
      const identity = request.authSession?.user.publicId;
      if (identity === undefined) return true;
      const grantId = parseGrantId(request.params?.grantId);
      await this.limiter.consume({
        surface: 'grant-rotate-owner',
        purpose: 'rate-limit-grant/v1',
        identity: `${identity}\u0000${grantId}`,
        limit: 5,
        windowMs: 60 * 60 * 1_000,
      });
      return true;
    }
    const identity = request.authSession?.user.publicId;
    if (identity === undefined || surface === 'pairing-claim') return true;
    if (surface === 'password-change') {
      await this.limiter.consume({
        surface: 'password-change-owner',
        purpose: 'rate-limit-user/v1',
        identity,
        limit: 5,
        windowMs: 60 * 60 * 1_000,
      });
      return true;
    }
    await this.limiter.consume({
      surface: `${surface}-owner`,
      purpose: 'rate-limit-user/v1',
      identity,
      limit: surface === 'pairing-create' ? 3 : 20,
      windowMs: 10 * 60 * 1_000,
    });
    return true;
  }
}

const preAuthPolicy = (surface: D2RateLimitedSurface): { limit: number; windowMs: number } => {
  if (surface === 'csrf-bootstrap') return { limit: 60, windowMs: 10 * 60 * 1_000 };
  if (surface === 'signup') return { limit: 5, windowMs: 60 * 60 * 1_000 };
  if (surface === 'login') return { limit: 20, windowMs: 15 * 60 * 1_000 };
  if (surface === 'email-verification-request') return { limit: 10, windowMs: 60 * 60 * 1_000 };
  if (surface === 'email-verification-confirm') return { limit: 30, windowMs: 15 * 60 * 1_000 };
  if (surface === 'password-change') return { limit: 20, windowMs: 15 * 60 * 1_000 };
  if (surface === 'session-renewal') return { limit: 120, windowMs: 5 * 60 * 1_000 };
  if (surface === 'pairing-client-status') return { limit: 300, windowMs: 5 * 60 * 1_000 };
  if (surface === 'pairing-create') return { limit: 30, windowMs: 10 * 60 * 1_000 };
  if (surface === 'pairing-claim') return { limit: 10, windowMs: 10 * 60 * 1_000 };
  if (surface === 'grant-rotate') return { limit: 60, windowMs: 60 * 60 * 1_000 };
  return { limit: 60, windowMs: surface === 'pairing-redeem' ? 5 * 60 * 1_000 : 10 * 60 * 1_000 };
};
