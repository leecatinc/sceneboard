export type MediaCleanupPhaseV1 =
  | 'intent'
  | 'ownership_quarantined'
  | 'refs_rechecked'
  | 'ownership_released'
  | 'object_quarantined'
  | 'object_deleted'
  | 'complete'
  | 'quarantined';

export type MediaCleanupLeaseV1 = Readonly<{
  runId: string;
  leaseOwner: string;
  fence: bigint;
}>;

export type MediaCleanupItemV1 = Readonly<{
  cleanupId: bigint;
  boardPk: bigint;
  boardMediaPk: bigint;
  mediaPk: bigint;
  expectedBoardMediaVersion: bigint;
  expectedObjectVersion: bigint;
  phase: MediaCleanupPhaseV1;
  attempts: number;
  objectSha256: Buffer;
  byteLength: number;
  deleteAfter: string | null;
  backupDeploymentId: string | null;
  backupAttemptSeq: bigint | null;
  backupManifestSha256: Buffer | null;
}>;
