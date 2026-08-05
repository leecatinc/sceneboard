import { AppError } from '../common/errors/app-error.js';

export interface AuthCredentials {
  email: string;
  emailNormalized: string;
  password: string;
}

export const EMAIL_VERIFICATION_LOCALES = [
  'en',
  'ko',
  'ja',
  'zh-CN',
  'zh-TW',
  'es',
  'fr',
  'de',
  'pt-BR',
  'ru',
] as const;

export type EmailVerificationLocale = (typeof EMAIL_VERIFICATION_LOCALES)[number];

export interface EmailVerificationRequest {
  email: string;
  emailNormalized: string;
  locale: EmailVerificationLocale;
}

export interface EmailVerificationConfirmation {
  email: string;
  emailNormalized: string;
  code: string;
}

export interface SignupCredentials extends AuthCredentials {
  verificationTicket: string;
}

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}

export interface GoogleIdTokenRequest {
  idToken: string;
}

const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const parseVerifiedEmail = (input: unknown): { email: string; emailNormalized: string } => {
  if (typeof input !== 'string') throw new AppError('INVALID_PAYLOAD');
  const email = input.replace(/^ +| +$/g, '');
  const emailBytes = Buffer.byteLength(email, 'utf8');
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  const domain = at > 0 ? email.slice(at + 1) : '';
  if (
    emailBytes < 5 ||
    emailBytes > 254 ||
    Buffer.byteLength(local, 'ascii') > 64 ||
    Buffer.byteLength(domain, 'ascii') > 253 ||
    !/^[\x20-\x7e]+$/.test(email) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !EMAIL_PATTERN.test(email)
  )
    throw new AppError('INVALID_PAYLOAD');
  return { email, emailNormalized: email.toLowerCase() };
};

export const parseAuthCredentials = (input: unknown): AuthCredentials => {
  if (!isRecord(input) || !hasExactKeys(input, ['email', 'password']))
    throw new AppError('INVALID_PAYLOAD');
  if (typeof input.email !== 'string' || typeof input.password !== 'string')
    throw new AppError('INVALID_PAYLOAD');
  return { ...parseVerifiedEmail(input.email), password: input.password };
};

export const parseSignupCredentials = (input: unknown): SignupCredentials => {
  if (!isRecord(input) || !hasExactKeys(input, ['email', 'password', 'verificationTicket'])) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (typeof input.password !== 'string' || typeof input.verificationTicket !== 'string') {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (input.verificationTicket.length < 80 || input.verificationTicket.length > 256) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return {
    ...parseVerifiedEmail(input.email),
    password: input.password,
    verificationTicket: input.verificationTicket,
  };
};

export const parseEmailVerificationRequest = (input: unknown): EmailVerificationRequest => {
  if (!isRecord(input) || !hasExactKeys(input, ['email', 'locale']))
    throw new AppError('INVALID_PAYLOAD');
  if (
    typeof input.locale !== 'string' ||
    !EMAIL_VERIFICATION_LOCALES.includes(input.locale as EmailVerificationLocale)
  ) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return { ...parseVerifiedEmail(input.email), locale: input.locale as EmailVerificationLocale };
};

export const parseEmailVerificationConfirmation = (
  input: unknown,
): EmailVerificationConfirmation => {
  if (!isRecord(input) || !hasExactKeys(input, ['email', 'code']))
    throw new AppError('INVALID_PAYLOAD');
  if (typeof input.code !== 'string' || !/^[0-9]{6}$/.test(input.code))
    throw new AppError('INVALID_PAYLOAD');
  return { ...parseVerifiedEmail(input.email), code: input.code };
};

export const parseGoogleIdTokenRequest = (input: unknown): GoogleIdTokenRequest => {
  if (!isRecord(input) || !hasExactKeys(input, ['idToken']) || typeof input.idToken !== 'string')
    throw new AppError('INVALID_PAYLOAD');
  if (
    input.idToken.length < 256 ||
    input.idToken.length > 16_384 ||
    !/^[A-Za-z0-9._-]+$/u.test(input.idToken)
  )
    throw new AppError('INVALID_PAYLOAD');
  return { idToken: input.idToken };
};

export const parsePasswordChangeRequest = (input: unknown): PasswordChangeRequest => {
  if (!isRecord(input) || !hasExactKeys(input, ['currentPassword', 'newPassword'])) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (typeof input.currentPassword !== 'string' || typeof input.newPassword !== 'string') {
    throw new AppError('INVALID_PAYLOAD');
  }
  const currentPasswordBytes = Buffer.byteLength(input.currentPassword, 'utf8');
  if (currentPasswordBytes === 0 || currentPasswordBytes > 72)
    throw new AppError('INVALID_PAYLOAD');
  return { currentPassword: input.currentPassword, newPassword: input.newPassword };
};

export const parseEmptyObject = (input: unknown): Record<string, never> => {
  if (!isRecord(input) || Object.keys(input).length !== 0) throw new AppError('INVALID_PAYLOAD');
  return Object.create(null) as Record<string, never>;
};
