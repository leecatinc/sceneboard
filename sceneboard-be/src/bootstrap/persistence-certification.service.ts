import { Injectable } from '@nestjs/common';

import {
  PERSISTENCE_PROBE_ORDER_V1,
  PersistenceProbeFailure,
  type CertificationDispatchV1,
  type PersistenceCertificationFailureCategoryV1,
  type PersistenceCertificationProbeV1,
  type PersistenceCertificationResultV1,
  type PersistenceCertificationServiceV1,
  type PersistenceProbeIdV1,
} from './persistence-certification.types.js';

const BOUNDED_DEADLINE_MS = 30_000;
const METADATA_BYTES = 1_048_576;
const PAYLOAD_BYTES = 16_777_216;
const rowsFor = (probeId: PersistenceProbeIdV1): number => {
  if (probeId === 'idempotency-result' || probeId === 'outbox-event') return 250;
  if (probeId === 'checkpoint-ref-sequence') return 100;
  return 500;
};

const safeCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const failureCategory = (
  error: unknown,
): { category: PersistenceCertificationFailureCategoryV1; retryable: boolean } =>
  error instanceof PersistenceProbeFailure
    ? { category: error.category, retryable: error.retryable }
    : { category: 'PROBE', retryable: false };

@Injectable()
export class PersistenceCertificationService implements PersistenceCertificationServiceV1 {
  readonly #probes: ReadonlyMap<PersistenceProbeIdV1, PersistenceCertificationProbeV1>;

  constructor(
    probes: readonly PersistenceCertificationProbeV1[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#probes = new Map(probes.map((probe) => [probe.probeId, probe]));
    if (
      this.#probes.size !== PERSISTENCE_PROBE_ORDER_V1.length ||
      PERSISTENCE_PROBE_ORDER_V1.some((probeId) => !this.#probes.has(probeId))
    ) {
      throw new TypeError('persistence certification requires the exact probe graph');
    }
  }

  async certify<Dispatch extends CertificationDispatchV1>(
    dispatch: Dispatch,
  ): Promise<PersistenceCertificationResultV1<Dispatch>> {
    const controller = new AbortController();
    const deadline =
      dispatch.certificationMode === 'BOUNDED_RESTART'
        ? setTimeout(() => controller.abort(), BOUNDED_DEADLINE_MS)
        : null;
    deadline?.unref();
    let scannedRows = 0;
    let scannedBytes = 0;
    let deferredRows = 0;
    try {
      for (const probeId of PERSISTENCE_PROBE_ORDER_V1) {
        const probe = this.#probes.get(probeId);
        if (!probe) throw new PersistenceProbeFailure('ORDERING', false);
        let cursor: string | null = null;
        do {
          if (controller.signal.aborted) throw new PersistenceProbeFailure('DEADLINE', true);
          const startedAt = performance.now();
          const result = await probe.run({
            probeId,
            mode: dispatch.certificationMode,
            scope:
              dispatch.certificationMode === 'BOUNDED_RESTART'
                ? 'bounded-canary'
                : 'complete-keyset',
            cursor,
            maxRows: dispatch.certificationMode === 'BOUNDED_RESTART' ? 200 : rowsFor(probeId),
            maxMetadataBytes: METADATA_BYTES,
            maxPayloadBytes: probeId === 'checkpoint-ref-sequence' ? 800_000 : PAYLOAD_BYTES,
            statementTimeoutMs: 5_000,
            batchDeadlineMs: 15_000,
            signal: controller.signal,
          });
          if (performance.now() - startedAt > 15_000)
            throw new PersistenceProbeFailure('DEADLINE', true);
          if (
            ![result.scannedRows, result.scannedBytes, result.deferredRows].every(safeCount) ||
            result.scannedRows >
              (dispatch.certificationMode === 'BOUNDED_RESTART' ? 200 : rowsFor(probeId)) ||
            (!result.complete && (result.nextCursor === null || result.nextCursor === cursor)) ||
            (dispatch.certificationMode === 'BOUNDED_RESTART' && !result.complete)
          ) {
            throw new PersistenceProbeFailure('CURSOR', false);
          }
          scannedRows += result.scannedRows;
          scannedBytes += result.scannedBytes;
          deferredRows += result.deferredRows;
          if (![scannedRows, scannedBytes, deferredRows].every(safeCount)) {
            throw new PersistenceProbeFailure('ROW_MAPPING', false);
          }
          cursor = result.complete ? null : result.nextCursor;
          if (result.complete) break;
        } while (dispatch.certificationMode !== 'BOUNDED_RESTART');
      }
      const certifiedAt = this.now().toISOString();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(certifiedAt)) {
        throw new PersistenceProbeFailure('STATE_OR_PROFILE', false);
      }
      return {
        status: 'succeeded',
        caller: dispatch.caller,
        certificationMode: dispatch.certificationMode,
        stateMode: dispatch.stateMode,
        registryVersion: dispatch.registryVersion,
        connectionProfile: dispatch.connectionProfile,
        certifiedAt,
        scannedRows,
        scannedBytes,
        deferredRows,
        successAction: dispatch.successAction,
        authorizesListener: dispatch.authorizesListener,
      };
    } catch (error) {
      const safe = failureCategory(error);
      return {
        status: 'failed',
        code: 'PERSISTENCE_CERTIFICATION_FAILED',
        category: safe.category,
        caller: dispatch.caller,
        certificationMode: dispatch.certificationMode,
        stateMode: dispatch.stateMode,
        registryVersion: dispatch.registryVersion,
        retryable: safe.retryable,
        authorizesListener: false,
      };
    } finally {
      if (deadline !== null) clearTimeout(deadline);
    }
  }
}
