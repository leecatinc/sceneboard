import { ACCOUNT_API_KEY_SCOPES_V1, type AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import { AppError } from '../common/errors/app-error.js';
import { parseAccountApiKeyScopes } from './account-api-key.scope.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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
  expiresAt: number | undefined;
};

export const parseAccountApiKeyCreateDto = (value: unknown): AccountApiKeyCreateDto => {
  const source = record(value, ['displayName', 'scopes', 'expiresAt']);
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
  if (typeof source.expiresAt !== 'string' || !ISO_TIMESTAMP.test(source.expiresAt))
    throw new AppError('INVALID_PAYLOAD');
  const expiresAt = Date.parse(source.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== source.expiresAt) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return {
    displayName: source.displayName,
    scopes: source.scopes === undefined ? undefined : scopes,
    expiresAt,
  };
};

export const parseAccountApiKeyId = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new AppError('API_KEY_NOT_FOUND');
  return value;
};

export const accountApiKeyScopeCatalog = (): readonly AccountApiKeyScopeV1[] =>
  ACCOUNT_API_KEY_SCOPES_V1;
