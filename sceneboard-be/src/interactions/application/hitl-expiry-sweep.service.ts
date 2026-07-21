import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { type EventId, type RequestId, type TimestampV1 } from '@sceneboard/board-schema';

import { generatePublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { formatMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import { MysqlService } from '../../database/mysql.service.js';
import { withTransaction } from '../../database/transaction.js';
import { ControlMutationRepository } from '../../revisions/control-mutation.repository.js';
import { InteractionRepository } from '../persistence/interaction.repository.js';
import { HitlExpiryService } from './hitl-expiry.service.js';
import { internalHitlFailure } from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

const SYSTEM_EXPIRY_REQUEST_ID = 'hitl-expiry-v1' as RequestId;

export class HitlExpirySweepService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HitlExpirySweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly mysql: MysqlService,
    private readonly interactions: InteractionRepository,
    private readonly mutations: ControlMutationRepository,
    private readonly expiry: HitlExpiryService,
    private readonly waits: HitlWaitCoordinator,
    private readonly clock: () => Date = () => new Date(),
    private readonly eventId: () => string = generatePublicUuidV4,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<number> {
    const now = this.clock();
    if (!Number.isFinite(now.valueOf())) throw internalHitlFailure();
    const nowSql = formatMysqlTimestampUtc(now);
    const candidates = await this.mysql.withConnection((connection) =>
      this.interactions.findDueCandidates(connection, nowSql, 100),
    );
    let winners = 0;
    for (const candidate of candidates) {
      const eventId = this.eventId() as EventId;
      const occurredAt = now.toISOString() as TimestampV1;
      const changed = await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const head = await this.mutations.lockCurrentHead(connection, candidate.boardId, false);
          const stored = await this.interactions.lockByBoardPk(
            connection,
            head.boardPk,
            candidate.hitlRequestId,
          );
          if (
            stored === null ||
            stored.interaction.state !== 'open' ||
            Date.parse(stored.interaction.expiresAt as TimestampV1) > now.valueOf()
          )
            return false;
          await this.expiry.expireLocked(connection, {
            head,
            boardId: candidate.boardId,
            stored,
            now,
            eventId,
            occurredAt,
            requestId: SYSTEM_EXPIRY_REQUEST_ID,
            context: null,
          });
          return true;
        }),
      );
      if (changed) {
        winners += 1;
        this.waits.notify(`${candidate.boardId}\0${candidate.hitlRequestId}`);
      }
    }
    return winners;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch {
      this.logger.error('HITL expiry sweep failed');
    } finally {
      this.running = false;
    }
  }
}
