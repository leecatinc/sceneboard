import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { MysqlService } from '../database/mysql.service.js';
import type { ExportRevisionHoldRepositoryV1 } from './export-revision-hold.repository.js';

const RECOVERY_INTERVAL_MS_V1 = 30_000;

export class ExportCleanupServiceV1 implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly mysql: MysqlService,
    private readonly holds: ExportRevisionHoldRepositoryV1,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.recover(), RECOVERY_INTERVAL_MS_V1);
    this.timer.unref();
    void this.recover();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.recovery?.catch(() => undefined);
  }

  async recover(): Promise<void> {
    if (this.recovery !== null) return this.recovery;
    this.recovery = this.mysql
      .withConnection(async (connection) => {
        await this.holds.recoverExpired(connection);
      })
      .catch(() => undefined)
      .finally(() => {
        this.recovery = null;
      });
    return this.recovery;
  }
}
