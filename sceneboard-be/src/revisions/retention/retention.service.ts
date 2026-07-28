import { createHash, randomUUID } from 'node:crypto';

import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import { RetentionLockService, type RetentionLeaseV1 } from './retention-lock.service.js';
import { RetentionRepository, type RetentionCandidateV1 } from './retention.repository.js';

export interface RetentionDryRunV1 {
  candidateCount: number;
  storedBytes: number;
  candidates: Array<{ revisionPk: string; revisionNumber: number; storedBytes: number }>;
}

export class RetentionService {
  constructor(
    private readonly repository = new RetentionRepository(),
    private readonly locks = new RetentionLockService(),
  ) {}

  async dryRun(
    connection: PoolConnection,
    boardPk: string,
    retainedCount: number,
  ): Promise<RetentionDryRunV1> {
    return this.report(
      await this.repository.selectCandidates(connection, boardPk, retainedCount, false),
    );
  }

  async plan(
    connection: PoolConnection,
    boardPk: string,
    retainedCount: number,
    ownerToken: string,
  ): Promise<{ lease: RetentionLeaseV1; report: RetentionDryRunV1 } | null> {
    const lease = await this.locks.acquire(connection, {
      boardPk,
      runId: randomUUID(),
      ownerToken,
    });
    if (lease === null) return null;
    const candidates = await this.repository.selectCandidates(
      connection,
      boardPk,
      retainedCount,
      true,
    );
    const holdSnapshot = createHash('sha256')
      .update(
        candidates
          .map((candidate) => `${candidate.revisionPk}:${candidate.payloadSha256.toString('hex')}`)
          .join('\n'),
        'ascii',
      )
      .digest();
    await this.locks.assertOwned(connection, lease);
    await this.repository.persistPlan(connection, lease, candidates, holdSnapshot);
    return { lease, report: this.report(candidates) };
  }

  private report(candidates: readonly RetentionCandidateV1[]): RetentionDryRunV1 {
    const storedBytes = candidates.reduce((total, candidate) => total + candidate.storedBytes, 0);
    if (!Number.isSafeInteger(storedBytes)) throw new BoardPersistenceError('row_integrity');
    return {
      candidateCount: candidates.length,
      storedBytes,
      candidates: candidates.map(({ revisionPk, revisionNumber, storedBytes: bytes }) => ({
        revisionPk,
        revisionNumber,
        storedBytes: bytes,
      })),
    };
  }
}
