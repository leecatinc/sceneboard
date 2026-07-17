import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';

import { APP_ENVIRONMENT, type AppEnvironment } from '../../config/env.schema.js';

interface CorsRequestV1 {
  method: string;
  originalUrl?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface CorsResponseV1 {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(): unknown;
}

type RouteProfileV1 = {
  pattern: RegExp;
  methods: readonly string[];
  headers: readonly string[];
};

const DEFAULT_HEADERS = ['Content-Type', 'X-CSRF-Token'] as const;
const ROUTES: readonly RouteProfileV1[] = [
  { pattern: /^\/api\/v1\/boards\/[^/]+\/events$/u, methods: ['GET'], headers: ['Last-Event-ID'] },
  { pattern: /^\/api\/v1\/auth\/(?:csrf|session)$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/auth\/(?:signup|login|password|session\/renew|logout|email-verifications(?:\/confirm)?)$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings\/claim$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings\/active$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings\/[^/]+$/u, methods: ['GET', 'DELETE'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings\/[^/]+\/(?:decision|redeem)$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/pairings\/[^/]+\/client-status$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/grants$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/grants\/[^/]+$/u, methods: ['DELETE'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/grants\/[^/]+\/rotate$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/mcp\/connection$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards$/u, methods: ['GET', 'POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/title$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/(?:capabilities|revisions)$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/(?:archive|mutations)$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/revisions\/[^/]+$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/revisions\/[^/]+\/restore$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/artifacts$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/artifacts\/[^/]+\/versions\/[^/]+(?:\/package)?$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/artifacts\/[^/]+\/versions\/[^/]+\/capability-requests\/network-fetch$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/interactions\/[^/]+$/u, methods: ['GET'], headers: DEFAULT_HEADERS },
  { pattern: /^\/api\/v1\/boards\/[^/]+\/interactions\/[^/]+\/(?:cancel|supersede)$/u, methods: ['POST'], headers: DEFAULT_HEADERS },
];

export type CorsPreflightDecisionV1 =
  | { allowed: true; method: string; headers: readonly string[] }
  | { allowed: false };

const singleton = (value: string | string[] | undefined): string | null => (
  typeof value === 'string' ? value : null
);

const requestedHeaders = (source: string | undefined): string[] | null => {
  if (source === undefined || source === '') return [];
  const entries = source.split(',').map((value) => value.trim());
  if (entries.some((value) => value === '' || !/^[A-Za-z0-9-]+$/u.test(value))) return null;
  const lower = entries.map((value) => value.toLowerCase());
  if (new Set(lower).size !== lower.length) return null;
  return lower;
};

export const evaluateCorsPreflightV1 = (
  path: string,
  requestedMethod: string | undefined,
  requestedHeaderSource: string | undefined,
): CorsPreflightDecisionV1 => {
  const profile = ROUTES.find((candidate) => candidate.pattern.test(path));
  if (profile === undefined || requestedMethod === undefined || !profile.methods.includes(requestedMethod)) {
    return { allowed: false };
  }
  const requested = requestedHeaders(requestedHeaderSource);
  if (requested === null) return { allowed: false };
  const allowedLower = profile.headers.map((value) => value.toLowerCase());
  if (requested.some((value) => !allowedLower.includes(value))) return { allowed: false };
  return {
    allowed: true,
    method: requestedMethod,
    headers: profile.headers.filter((value) => requested.includes(value.toLowerCase())),
  };
};

@Injectable()
export class CorsPolicyMiddleware implements NestMiddleware {
  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment) {}

  use(request: CorsRequestV1, response: CorsResponseV1, next: () => void): void {
    const origin = singleton(request.headers.origin);
    if (request.method !== 'OPTIONS') {
      if (origin === this.environment.browserOrigin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Auth-Generation, Retry-After');
      }
      next();
      return;
    }
    const path = (request.originalUrl ?? request.url ?? '').split('?', 1)[0] ?? '';
    const method = singleton(request.headers['access-control-request-method']);
    const headers = singleton(request.headers['access-control-request-headers']);
    const decision = origin === this.environment.browserOrigin
      ? evaluateCorsPreflightV1(path, method ?? undefined, headers ?? undefined)
      : { allowed: false } as const;
    if (!decision.allowed) {
      response.statusCode = 403;
      response.end();
      return;
    }
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Origin', origin as string);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', decision.method);
    if (decision.headers.length > 0) response.setHeader('Access-Control-Allow-Headers', decision.headers.join(', '));
    response.setHeader('Access-Control-Max-Age', '600');
    response.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    response.end();
  }
}
