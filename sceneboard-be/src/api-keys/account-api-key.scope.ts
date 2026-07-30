import {
  ACCOUNT_API_KEY_SCOPES_V1,
  ACCOUNT_API_KEY_SCOPE_BITS_V1,
  type AccountApiKeyScopeV1,
} from '@sceneboard/board-schema';

import { AppError } from '../common/errors/app-error.js';

export const DEFAULT_ACCOUNT_API_KEY_SCOPES = [
  'board:read',
] as const satisfies readonly AccountApiKeyScopeV1[];

const scopeSet = new Set<string>(ACCOUNT_API_KEY_SCOPES_V1);

export const parseAccountApiKeyScopes = (
  input: readonly string[] | undefined,
): readonly AccountApiKeyScopeV1[] => {
  if (input === undefined) return DEFAULT_ACCOUNT_API_KEY_SCOPES;
  if (
    input.length === 0 ||
    input.some((scope) => !scopeSet.has(scope)) ||
    input.some((scope, index) => index > 0 && (input[index - 1] ?? '') >= scope)
  ) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return input as readonly AccountApiKeyScopeV1[];
};

export const accountApiKeyScopeMask = (scopes: readonly AccountApiKeyScopeV1[]): number =>
  scopes.reduce((mask, scope) => mask | ACCOUNT_API_KEY_SCOPE_BITS_V1[scope], 0);

export const accountApiKeyScopesFromMask = (mask: number): readonly AccountApiKeyScopeV1[] => {
  if (!Number.isSafeInteger(mask) || mask < 1 || mask > 63) {
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  const scopes = ACCOUNT_API_KEY_SCOPES_V1.filter(
    (scope) => (mask & ACCOUNT_API_KEY_SCOPE_BITS_V1[scope]) !== 0,
  );
  if (accountApiKeyScopeMask(scopes) !== mask) throw new AppError('SERVICE_UNAVAILABLE');
  return scopes;
};
