import type { MigrationCertificationStateV1 } from '../database/migrations/certification-state.js';

export type MediaWriterCertificationV1 = Readonly<{
  revisionMediaRefsReady: boolean;
  mediaStoreProjectionReady: boolean;
  mediaRetentionRecoveryReady: boolean;
  mediaNativeDecoderReady: boolean;
  artifactDigests: Readonly<{
    migration: string;
    projection: string;
    nativeManifest: string;
  }>;
  checkedAt: string;
}>;

export type CertificationModeV1 = 'FULL_OFFLINE' | 'BOUNDED_RESTART' | 'RESUMABLE_AUDIT';

export type CertificationCallerV1 =
  | 'db:migrate:up'
  | 'db:migrate:adopt'
  | 'quarantine.restore.promote'
  | 'db:migrate:status'
  | 'http-mcp.bootstrap'
  | 'db:persistence:scan';

type CertificationStateFieldsV1<Mode extends MigrationCertificationStateV1['mode']> = Readonly<{
  stateMode: Mode;
  registryVersion: MigrationCertificationStateV1['registryVersion'];
  connectionProfile: MigrationCertificationStateV1['connectionProfile'];
}>;

export type CertificationDispatchV1 =
  | (CertificationStateFieldsV1<'fresh' | 'restart'> &
      Readonly<{
        caller: 'db:migrate:up';
        certificationMode: 'FULL_OFFLINE';
        successAction: 'CLI_EXIT_0_LISTENERS_STOPPED';
        authorizesListener: false;
      }>)
  | (CertificationStateFieldsV1<'adopt'> &
      Readonly<{
        caller: 'db:migrate:adopt';
        certificationMode: 'FULL_OFFLINE';
        successAction: 'CLI_EXIT_0_LISTENERS_STOPPED';
        authorizesListener: false;
      }>)
  | (CertificationStateFieldsV1<'restart'> &
      Readonly<{
        caller: 'quarantine.restore.promote';
        certificationMode: 'FULL_OFFLINE';
        successAction: 'WRITE_PROMOTION_EVIDENCE_LISTENERS_STOPPED';
        authorizesListener: false;
      }>)
  | (CertificationStateFieldsV1<'restart'> &
      Readonly<{
        caller: 'db:migrate:status';
        certificationMode: 'BOUNDED_RESTART';
        successAction: 'CLI_EXIT_0_BOUNDED_REPORT_ONLY';
        authorizesListener: false;
      }>)
  | (CertificationStateFieldsV1<'restart'> &
      Readonly<{
        caller: 'http-mcp.bootstrap';
        certificationMode: 'BOUNDED_RESTART';
        successAction: 'START_LISTENER';
        authorizesListener: true;
      }>)
  | (CertificationStateFieldsV1<'restart'> &
      Readonly<{
        caller: 'db:persistence:scan';
        certificationMode: 'RESUMABLE_AUDIT';
        successAction: 'CLI_EXIT_0_OPERATOR_EVIDENCE_ONLY';
        authorizesListener: false;
      }>);

export type PersistenceCertificationFailureCategoryV1 =
  | 'CONNECTION'
  | 'STATE_OR_PROFILE'
  | 'SCHEMA_METADATA'
  | 'DEADLINE'
  | 'ROW_MAPPING'
  | 'PROBE'
  | 'CURSOR'
  | 'HIGH_WATER_CHANGED'
  | 'ORDERING'
  | 'INTERRUPTED'
  | 'INCONCLUSIVE_CONCURRENT_CHANGE';

export type PersistenceCertificationSuccessV1<
  Dispatch extends CertificationDispatchV1 = CertificationDispatchV1,
> = Readonly<{
  status: 'succeeded';
  caller: Dispatch['caller'];
  certificationMode: Dispatch['certificationMode'];
  stateMode: Dispatch['stateMode'];
  registryVersion: Dispatch['registryVersion'];
  connectionProfile: Dispatch['connectionProfile'];
  certifiedAt: string;
  scannedRows: number;
  scannedBytes: number;
  deferredRows: number;
  successAction: Dispatch['successAction'];
  authorizesListener: Dispatch['authorizesListener'];
}>;

export type PersistenceCertificationFailureV1<
  Dispatch extends CertificationDispatchV1 = CertificationDispatchV1,
> = Readonly<{
  status: 'failed';
  code: 'PERSISTENCE_CERTIFICATION_FAILED';
  category: PersistenceCertificationFailureCategoryV1;
  caller: Dispatch['caller'];
  certificationMode: Dispatch['certificationMode'];
  stateMode: Dispatch['stateMode'];
  registryVersion: Dispatch['registryVersion'];
  retryable: boolean;
  authorizesListener: false;
}>;

export type PersistenceCertificationResultV1<
  Dispatch extends CertificationDispatchV1 = CertificationDispatchV1,
> = PersistenceCertificationSuccessV1<Dispatch> | PersistenceCertificationFailureV1<Dispatch>;

export interface PersistenceCertificationServiceV1 {
  certify<Dispatch extends CertificationDispatchV1>(
    dispatch: Dispatch,
  ): Promise<PersistenceCertificationResultV1<Dispatch>>;
}

export const PERSISTENCE_PROBE_ORDER_V1 = [
  'd2-binding-public-id-owner-fk',
  'd3-board-public-id-owner-head',
  'revision-head-lineage',
  'idempotency-result',
  'outbox-event',
  'checkpoint-ref-sequence',
] as const;

export type PersistenceProbeIdV1 = (typeof PERSISTENCE_PROBE_ORDER_V1)[number];

export type PersistenceProbeInputV1 = Readonly<{
  probeId: PersistenceProbeIdV1;
  mode: CertificationModeV1;
  scope: 'complete-keyset' | 'bounded-canary';
  cursor: string | null;
  maxRows: number;
  maxMetadataBytes: number;
  maxPayloadBytes: number;
  statementTimeoutMs: 5_000;
  batchDeadlineMs: 15_000;
  signal: AbortSignal;
}>;

export type PersistenceProbeBatchResultV1 = Readonly<{
  complete: boolean;
  nextCursor: string | null;
  scannedRows: number;
  scannedBytes: number;
  deferredRows: number;
}>;

export interface PersistenceCertificationProbeV1 {
  readonly probeId: PersistenceProbeIdV1;
  run(input: PersistenceProbeInputV1): Promise<PersistenceProbeBatchResultV1>;
}

export class PersistenceProbeFailure extends Error {
  constructor(
    readonly category: PersistenceCertificationFailureCategoryV1,
    readonly retryable: boolean,
  ) {
    super('persistence probe failed');
    this.name = 'PersistenceProbeFailure';
  }
}
