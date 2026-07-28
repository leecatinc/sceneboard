import {
  REVISION_RETENTION_MAXIMUM,
  REVISION_RETENTION_MINIMUM,
  type RetainedRevisionBoundaryV1,
  type RevisionRetentionPolicyV1,
} from './retention.types.js';

const MAX_SAFE_REVISION_NUMBER = 9_007_199_254_740_991;

const requireCanonicalInteger = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside its closed integer range`);
  }
  return value;
};

export const createRevisionRetentionPolicyV1 = (
  accessibleRevisionCount: number,
): RevisionRetentionPolicyV1 =>
  Object.freeze({
    accessibleRevisionCount: requireCanonicalInteger(
      accessibleRevisionCount,
      REVISION_RETENTION_MINIMUM,
      REVISION_RETENTION_MAXIMUM,
      'accessibleRevisionCount',
    ),
  });

export const completeRetainedRevisionBoundaryV1 = (): RetainedRevisionBoundaryV1 =>
  Object.freeze({ kind: 'complete' });

export const truncatedRetainedRevisionBoundaryV1 = (
  oldestAccessibleRevisionNumber: number,
): RetainedRevisionBoundaryV1 =>
  Object.freeze({
    kind: 'truncated',
    oldestAccessibleRevisionNumber: requireCanonicalInteger(
      oldestAccessibleRevisionNumber,
      1,
      MAX_SAFE_REVISION_NUMBER,
      'oldestAccessibleRevisionNumber',
    ),
  });
