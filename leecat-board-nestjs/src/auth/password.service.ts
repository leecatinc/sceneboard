import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import bcrypt from 'bcryptjs';

import { AppError } from '../common/errors/app-error.js';
import { BCRYPT_DUMMY_HASH } from '../config/security.constants.js';

const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;

export class PasswordService {
  constructor(
    readonly cost: number,
    private readonly failureMinimumMs: number,
    private readonly failureJitterMs: number,
  ) {
    if (!Number.isInteger(cost) || cost < 10 || cost > 14) throw new TypeError('bcrypt cost must be between 10 and 14');
    if (bcrypt.getRounds(BCRYPT_DUMMY_HASH) !== cost) throw new TypeError('bcrypt dummy hash rounds do not match configured cost');
  }

  validate(password: string): void {
    const scalarCount = [...password].length;
    const bytes = Buffer.byteLength(password, 'utf8');
    if (scalarCount < 10 || bytes > 72 || password.includes('\0') || LONE_SURROGATE_PATTERN.test(password)) {
      throw new AppError('AUTH_PASSWORD_POLICY');
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password);
    return bcrypt.hash(password, this.cost);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return bcrypt.getRounds(hash) < this.cost;
    } catch {
      return false;
    }
  }

  dummyHash(): string {
    return BCRYPT_DUMMY_HASH;
  }

  async padFailure(startedAt: number, signal?: AbortSignal): Promise<void> {
    const target = this.failureMinimumMs + randomInt(0, this.failureJitterMs + 1);
    const remaining = Math.max(0, target - (performance.now() - startedAt));
    if (remaining > 0) await sleep(remaining, undefined, signal === undefined ? undefined : { signal });
  }
}
