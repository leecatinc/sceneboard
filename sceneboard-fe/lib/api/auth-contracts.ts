export interface AuthSessionSnapshot {
  user: { userId: string; email: string; createdAt: string };
  session: { sessionId: string; idleExpiresAt: string; absoluteExpiresAt: string };
  csrfToken: string;
}

export interface AnonymousCsrfSnapshot {
  csrfToken: string;
  expiresAt: string;
}

export interface EmailVerificationRequested {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface EmailVerificationConfirmed {
  verificationTicket: string;
  expiresAt: string;
}

export interface PublicApiError {
  error: { code: string; message: string; retryable?: boolean };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);

export const parseAuthSessionSnapshot = (value: unknown): AuthSessionSnapshot => {
  if (!isObject(value) || !exactKeys(value, ['user', 'session', 'csrfToken']))
    throw new TypeError('invalid auth session response');
  if (!isObject(value.user) || !exactKeys(value.user, ['userId', 'email', 'createdAt']))
    throw new TypeError('invalid auth user response');
  if (
    !isObject(value.session) ||
    !exactKeys(value.session, ['sessionId', 'idleExpiresAt', 'absoluteExpiresAt'])
  )
    throw new TypeError('invalid session response');
  if (
    typeof value.user.userId !== 'string' ||
    typeof value.user.email !== 'string' ||
    !timestamp(value.user.createdAt) ||
    typeof value.session.sessionId !== 'string' ||
    !timestamp(value.session.idleExpiresAt) ||
    !timestamp(value.session.absoluteExpiresAt) ||
    typeof value.csrfToken !== 'string'
  )
    throw new TypeError('invalid auth session response');
  return {
    user: { userId: value.user.userId, email: value.user.email, createdAt: value.user.createdAt },
    session: {
      sessionId: value.session.sessionId,
      idleExpiresAt: value.session.idleExpiresAt,
      absoluteExpiresAt: value.session.absoluteExpiresAt,
    },
    csrfToken: value.csrfToken,
  };
};

export const parseAnonymousCsrfSnapshot = (value: unknown): AnonymousCsrfSnapshot => {
  if (
    !isObject(value) ||
    !exactKeys(value, ['csrfToken', 'expiresAt']) ||
    typeof value.csrfToken !== 'string' ||
    !timestamp(value.expiresAt)
  )
    throw new TypeError('invalid CSRF response');
  return { csrfToken: value.csrfToken, expiresAt: value.expiresAt };
};

export const parseEmailVerificationRequested = (value: unknown): EmailVerificationRequested => {
  if (
    !isObject(value) ||
    !exactKeys(value, ['expiresInSeconds', 'resendAfterSeconds']) ||
    !Number.isSafeInteger(value.expiresInSeconds) ||
    !Number.isSafeInteger(value.resendAfterSeconds) ||
    (value.expiresInSeconds as number) < 1 ||
    (value.resendAfterSeconds as number) < 1
  )
    throw new TypeError('invalid email verification request response');
  return {
    expiresInSeconds: value.expiresInSeconds as number,
    resendAfterSeconds: value.resendAfterSeconds as number,
  };
};

export const parseEmailVerificationConfirmed = (value: unknown): EmailVerificationConfirmed => {
  if (
    !isObject(value) ||
    !exactKeys(value, ['verificationTicket', 'expiresAt']) ||
    typeof value.verificationTicket !== 'string' ||
    !timestamp(value.expiresAt)
  )
    throw new TypeError('invalid email verification confirmation response');
  return { verificationTicket: value.verificationTicket, expiresAt: value.expiresAt };
};

export const parsePublicApiError = (value: unknown): PublicApiError => {
  if (!isObject(value) || !exactKeys(value, ['error']) || !isObject(value.error))
    throw new TypeError('invalid API error');
  if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string')
    throw new TypeError('invalid API error');
  return { error: { code: value.error.code, message: value.error.message } };
};
