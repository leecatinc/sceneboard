import { BoardSdkHttpClient } from '@leecat-board/board-sdk/http';
import { z } from 'zod';

const GlobalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const TimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value);
const ScopeSchema = z.enum([
  'board.read',
  'board.write',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'artifact.publish',
  'artifact.control',
]);
const LifecycleSchema = z.enum(['board.create', 'board.archive']);
const ClientSchema = z.object({
  clientId: GlobalIdSchema,
  clientName: z.string().min(1).max(100),
  installationFingerprint: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
}).strict();

const ClaimResponseSchema = z.object({
  pairingId: GlobalIdSchema,
  state: z.literal('pending'),
  decisionExpiresAt: TimestampSchema,
  pollAfterSeconds: z.literal(2),
}).strict();

const StatusResponseSchema = z.object({
  pairingId: GlobalIdSchema,
  state: z.enum(['pending', 'approved', 'redeemed', 'denied', 'cancelled', 'expired']),
  retryAfterSeconds: z.union([z.literal(2), z.literal(5), z.literal(10)]).nullable(),
  decisionExpiresAt: TimestampSchema.nullable(),
  redeemExpiresAt: TimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.decisionExpiresAt === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionExpiresAt'], message: 'decision deadline is required' });
  if (value.state === 'pending' && (value.retryAfterSeconds === null || value.redeemExpiresAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'pending status is inconsistent' });
  }
  if (value.state !== 'pending' && value.retryAfterSeconds !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['retryAfterSeconds'], message: 'terminal delay is not allowed' });
  }
  if ((value.state === 'approved' || value.state === 'redeemed') && value.redeemExpiresAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['redeemExpiresAt'], message: 'redeem deadline is required' });
  }
  if (value.state === 'denied' && value.redeemExpiresAt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['redeemExpiresAt'], message: 'denied status has no redeem deadline' });
  }
});

const GrantSchema = z.object({
  grantId: GlobalIdSchema,
  client: ClientSchema,
  scopes: z.array(ScopeSchema).min(1).max(7),
  lifecyclePermissions: z.array(LifecycleSchema).max(2),
  boardIds: z.array(GlobalIdSchema).min(1).max(50),
  lifetime: z.enum(['session', 'persistent']),
  status: z.literal('active'),
  createdAt: TimestampSchema,
  activatedAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
  revokedAt: z.null(),
}).strict();

const RedeemResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().regex(/^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/),
  grant: GrantSchema,
}).strict();

const ErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'INVALID_PAYLOAD',
      'PAIRING_UNAVAILABLE',
      'PAIRING_PROOF_INVALID',
      'PAIRING_NOT_READY',
      'PAIRING_TERMINAL',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
    ]),
    message: z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  }).strict(),
}).strict();

export type PairingClaimRequestV1 = {
  code: string;
  installationId: string;
  clientName: string;
  requestedScopes: z.infer<typeof ScopeSchema>[];
  requestedLifecyclePermissions: z.infer<typeof LifecycleSchema>[];
  clientProofChallenge: string;
};

export type PairingClaimResponseV1 = z.infer<typeof ClaimResponseSchema>;
export type PairingClientStatusV1 = z.infer<typeof StatusResponseSchema>;
export type PairingRedeemResponseV1 = z.infer<typeof RedeemResponseSchema>;
export type PairingUpstreamErrorV1 = z.infer<typeof ErrorSchema>['error'] & { retryAfterSeconds: number | null };

export type PairingLocalErrorV1 =
  | { code: 'TRANSPORT_OUTCOME_UNKNOWN'; phase: 'claim' | 'redeem' }
  | { code: 'TRANSPORT_ERROR'; phase: 'status' }
  | { code: 'TIMEOUT'; timeoutMs: number }
  | { code: 'CANCELLED' }
  | { code: 'RESPONSE_INVALID'; reason: 'status' | 'content_type' | 'headers' | 'utf8' | 'json' | 'duplicate_member' | 'schema' | 'body_too_large' };

export type PairingHttpResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; source: 'pairing'; error: PairingUpstreamErrorV1 }
  | { ok: false; source: 'local'; error: PairingLocalErrorV1 };

export type PairingProofHeaderProviderV1 = () => string;

export type PairingHttpClientOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  proofHeaderProvider: PairingProofHeaderProviderV1;
};

type RouteKind = 'claim' | 'status' | 'redeem';

const expectedStatus: Readonly<Record<RouteKind, number>> = { claim: 202, status: 200, redeem: 200 };

const allowedErrorStatus: Readonly<Record<PairingUpstreamErrorV1['code'], number>> = {
  INVALID_PAYLOAD: 400,
  PAIRING_UNAVAILABLE: 400,
  PAIRING_PROOF_INVALID: 401,
  PAIRING_NOT_READY: 409,
  PAIRING_TERMINAL: 410,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

const parseRetryAfter = (response: Response): number | null | 'invalid' => {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  if (!/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/.test(value)) return 'invalid';
  return Number(value);
};

const validSecurityHeaders = (response: Response, route: RouteKind): boolean => {
  if (response.headers.get('cache-control') !== 'no-store, private' || response.headers.get('pragma') !== 'no-cache') return false;
  const vary = response.headers.get('vary');
  return route === 'claim' ? vary === null : vary === 'Authorization';
};

export class PairingHttpClientV1 {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #proofHeaderProvider: PairingProofHeaderProviderV1;

  constructor(options: PairingHttpClientOptionsV1) {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl) throw new TypeError('pairing base URL must be a canonical origin');
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
      throw new TypeError('pairing timeout is invalid');
    }
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#proofHeaderProvider = options.proofHeaderProvider;
  }

  claim(request: PairingClaimRequestV1, signal?: AbortSignal): Promise<PairingHttpResultV1<PairingClaimResponseV1>> {
    return this.#call('claim', '/api/v1/pairings/claim', 'POST', request, ClaimResponseSchema, signal);
  }

  clientStatus(pairingId: string, signal?: AbortSignal): Promise<PairingHttpResultV1<PairingClientStatusV1>> {
    return this.#call('status', `/api/v1/pairings/${encodeURIComponent(pairingId)}/client-status`, 'GET', null, StatusResponseSchema, signal);
  }

  redeem(pairingId: string, signal?: AbortSignal): Promise<PairingHttpResultV1<PairingRedeemResponseV1>> {
    return this.#call('redeem', `/api/v1/pairings/${encodeURIComponent(pairingId)}/redeem`, 'POST', {}, RedeemResponseSchema, signal);
  }

  async #call<T>(
    route: RouteKind,
    path: string,
    method: 'GET' | 'POST',
    body: unknown | null,
    schema: z.ZodType<T>,
    outerSignal?: AbortSignal,
  ): Promise<PairingHttpResultV1<T>> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = outerSignal === undefined ? timeoutSignal : AbortSignal.any([outerSignal, timeoutSignal]);
    if (signal.aborted) return { ok: false, source: 'local', error: { code: 'CANCELLED' } };
    let proof = '';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (route !== 'claim') {
      try {
        proof = this.#proofHeaderProvider();
      } catch {
        return { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR', phase: 'status' } };
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) {
        proof = '';
        return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'schema' } };
      }
      headers.Authorization = `PairingProof ${proof}`;
    }
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        redirect: 'manual',
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch {
      proof = '';
      if (outerSignal?.aborted) return { ok: false, source: 'local', error: { code: 'CANCELLED' } };
      if (timeoutSignal.aborted) return { ok: false, source: 'local', error: { code: 'TIMEOUT', timeoutMs: this.#timeoutMs } };
      return route === 'status'
        ? { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR', phase: 'status' } }
        : { ok: false, source: 'local', error: { code: 'TRANSPORT_OUTCOME_UNKNOWN', phase: route } };
    } finally {
      proof = '';
      delete headers.Authorization;
    }
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'status' } };
    }
    if (response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8') {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'content_type' } };
    }
    if (!validSecurityHeaders(response, route)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'headers' } };
    }
    const bytes = await BoardSdkHttpClient.readBoundedResponseBodyV1(response, 65_536, signal);
    if (typeof bytes === 'string') {
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: bytes === 'body_too_large' ? bytes : 'schema' } };
    }
    const parsed = BoardSdkHttpClient.parseStrictJsonBytesV1(bytes);
    if (!parsed.ok) return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: parsed.reason } };
    if (response.status === expectedStatus[route]) {
      const success = schema.safeParse(parsed.value);
      return success.success
        ? { ok: true, value: success.data }
        : { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'schema' } };
    }
    const failure = ErrorSchema.safeParse(parsed.value);
    if (!failure.success || allowedErrorStatus[failure.data.error.code] !== response.status) {
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'status' } };
    }
    const retryAfter = parseRetryAfter(response);
    const requiresRetry = failure.data.error.code === 'PAIRING_NOT_READY' || failure.data.error.code === 'RATE_LIMITED';
    if (retryAfter === 'invalid' || requiresRetry !== (retryAfter !== null)) {
      return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID', reason: 'headers' } };
    }
    return { ok: false, source: 'pairing', error: { ...failure.data.error, retryAfterSeconds: retryAfter } };
  }
}
