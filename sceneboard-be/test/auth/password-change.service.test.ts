import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PasswordPort } from '../../src/auth/auth.service.js';
import {
  PasswordChangeService,
  type PasswordChangePersistence,
} from '../../src/auth/password-change.service.js';
import type { SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';

class FakePasswords implements PasswordPort {
  readonly padded: number[] = [];

  validate(password: string): void {
    if (password === 'short') throw new AppError('AUTH_PASSWORD_POLICY');
  }

  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    return hash === `hash:${password}`;
  }

  needsRehash(): boolean {
    return false;
  }
  dummyHash(): string {
    return 'hash:dummy-password';
  }
  async padFailure(startedAt: number): Promise<void> {
    this.padded.push(startedAt);
  }
}

const session: SessionRecord = {
  databaseId: '10',
  publicId: 'session_1',
  familyPublicId: 'family_1',
  tokenHash: Buffer.alloc(32),
  status: 'active',
  user: {
    databaseId: '20',
    publicId: 'user_1',
    email: 'User@Example.dev',
    status: 'active',
    createdAt: '2026-07-17T00:00:00.000Z',
  },
  idleExpiresAt: 1_800_028_800_000,
  absoluteExpiresAt: 1_800_604_800_000,
};

test('changes a verified password and binds the commit to the current session family', async () => {
  const commits: Array<Parameters<PasswordChangePersistence['commit']>[0]> = [];
  const persistence: PasswordChangePersistence = {
    async findCandidate() {
      return { passwordHash: 'hash:current-password', status: 'active' };
    },
    async commit(input) {
      commits.push(input);
      return { kind: 'changed', otherSessionFamiliesRevoked: 2 };
    },
  };
  const service = new PasswordChangeService(persistence, new FakePasswords());

  await service.change(
    session,
    {
      currentPassword: 'current-password',
      newPassword: 'replacement-password',
    },
    1_800_000_000_000,
  );

  assert.equal(commits[0]?.userDatabaseId, session.user.databaseId);
  assert.equal(commits[0]?.currentSessionDatabaseId, session.databaseId);
  assert.equal(commits[0]?.currentFamilyPublicId, session.familyPublicId);
  assert.equal(commits[0]?.replacementPasswordHash, 'hash:replacement-password');
});

test('rejects and pads an incorrect current password without writing', async () => {
  let commits = 0;
  const passwords = new FakePasswords();
  const persistence: PasswordChangePersistence = {
    async findCandidate() {
      return { passwordHash: 'hash:current-password', status: 'active' };
    },
    async commit() {
      commits += 1;
      return { kind: 'changed', otherSessionFamiliesRevoked: 0 };
    },
  };
  const service = new PasswordChangeService(persistence, passwords);

  await assert.rejects(
    () =>
      service.change(
        session,
        { currentPassword: 'wrong-password', newPassword: 'replacement-password' },
        1_800_000_000_000,
      ),
    (error) => error instanceof AppError && error.code === 'AUTH_CURRENT_PASSWORD_INVALID',
  );
  assert.equal(commits, 0);
  assert.equal(passwords.padded.length, 1);
});

test('requires a different policy-compliant new password', async () => {
  const persistence: PasswordChangePersistence = {
    async findCandidate() {
      return { passwordHash: 'hash:current-password', status: 'active' };
    },
    async commit() {
      throw new Error('must not commit');
    },
  };
  const service = new PasswordChangeService(persistence, new FakePasswords());

  await assert.rejects(
    () =>
      service.change(
        session,
        { currentPassword: 'current-password', newPassword: 'current-password' },
        1_800_000_000_000,
      ),
    (error) => error instanceof AppError && error.code === 'AUTH_PASSWORD_UNCHANGED',
  );
  await assert.rejects(
    () =>
      service.change(
        session,
        { currentPassword: 'current-password', newPassword: 'short' },
        1_800_000_000_000,
      ),
    (error) => error instanceof AppError && error.code === 'AUTH_PASSWORD_POLICY',
  );
});
