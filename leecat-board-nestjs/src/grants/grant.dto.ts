import { AppError } from '../common/errors/app-error.js';

export interface GrantListQuery {
  cursor: string | null;
  limit: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const parseGrantListQuery = (value: unknown): GrantListQuery => {
  if (!isRecord(value)) throw new AppError('INVALID_PAYLOAD');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'cursor' && key !== 'limit')) throw new AppError('INVALID_PAYLOAD');
  const cursor = value.cursor === undefined ? null : value.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 512)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (value.limit === undefined) return { cursor, limit: 25 };
  if (typeof value.limit !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value.limit)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return { cursor, limit: Number(value.limit) };
};
