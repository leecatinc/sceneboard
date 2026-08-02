import { ACCOUNT_API_KEY_SCOPES_V1, type AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import { AppError } from '../common/errors/app-error.js';
import { parseAccountApiKeyScopes } from './account-api-key.scope.js';

const ACCOUNT_API_KEY_EXPIRY_DAYS = new Set([30, 90, 365]);

const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_PAYLOAD');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !keys.includes(key))) throw new AppError('INVALID_PAYLOAD');
  return source;
};

export type AccountApiKeyCreateDto = {
  displayName: string;
  scopes: readonly AccountApiKeyScopeV1[] | undefined;
  expiresInDays: 30 | 90 | 365;
};

export const parseAccountApiKeyCreateDto = (value: unknown): AccountApiKeyCreateDto => {
  const source = record(value, ['displayName', 'scopes', 'expiresInDays']);
  if (
    typeof source.displayName !== 'string' ||
    source.displayName !== source.displayName.trim() ||
    [...source.displayName].length < 1 ||
    [...source.displayName].length > 80
  )
    throw new AppError('INVALID_PAYLOAD');
  if (
    source.scopes !== undefined &&
    (!Array.isArray(source.scopes) || source.scopes.some((scope) => typeof scope !== 'string'))
  )
    throw new AppError('INVALID_PAYLOAD');
  const scopes = parseAccountApiKeyScopes(source.scopes as readonly string[] | undefined);
  if (
    typeof source.expiresInDays !== 'number' ||
    !Number.isSafeInteger(source.expiresInDays) ||
    !ACCOUNT_API_KEY_EXPIRY_DAYS.has(source.expiresInDays)
  )
    throw new AppError('INVALID_PAYLOAD');
  return {
    displayName: source.displayName,
    scopes: source.scopes === undefined ? undefined : scopes,
    expiresInDays: source.expiresInDays as 30 | 90 | 365,
  };
};

export const parseAccountApiKeyId = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new AppError('API_KEY_NOT_FOUND');
  return value;
};

export const accountApiKeyScopeCatalog = (): readonly AccountApiKeyScopeV1[] =>
  ACCOUNT_API_KEY_SCOPES_V1;
