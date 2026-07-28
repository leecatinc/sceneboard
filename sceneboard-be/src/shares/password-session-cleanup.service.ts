import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { CryptoService } from '../common/security/crypto.service.js';
import { MysqlService } from '../database/mysql.service.js';
import { withTransaction } from '../database/transaction.js';
import { PasswordShareRepository } from './password-share.repository.js';

export const SHARE_PASSWORD_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

@Injectable()
export class PasswordSessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly owner: Buffer;

  constructor(
    @Inject(MysqlService) private readonly mysql: MysqlService,
    @Inject(PasswordShareRepository) private readonly passwords: PasswordShareRepository,
    @Inject(CryptoService) crypto: CryptoService,
  ) {
    this.owner = Buffer.from(crypto.randomBase64Url(32), 'ascii');
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), SHARE_PASSWORD_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', () =>
          this.passwords.cleanupExpired(connection, { owner: this.owner }),
        ),
      );
    } catch {
      // The next fenced interval retries. Cleanup never changes request availability.
    } finally {
      this.running = false;
    }
  }
}
