export const REVISION_RETENTION_DEFAULT = 32;
export const REVISION_RETENTION_MINIMUM = 1;
export const REVISION_RETENTION_MAXIMUM = 256;

export type RevisionHoldKindV1 =
  | 'published'
  | 'media'
  | 'artifact'
  | 'idempotency'
  | 'outbox'
  | 'recovery'
  | 'restore';

export type RevisionRecoveryPhaseV1 =
  | 'planned'
  | 'core_applied'
  | 'refs_detached'
  | 'payload_cleared'
  | 'catalog_removed'
  | 'complete'
  | 'quarantined';

export type RetainedRevisionBoundaryV1 =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'truncated'; oldestAccessibleRevisionNumber: number }>;

export interface RevisionRetentionPolicyV1 {
  accessibleRevisionCount: number;
}
