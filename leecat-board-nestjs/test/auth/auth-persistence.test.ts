import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AuthPersistenceService,
  type AuditWriterPort,
  type SessionWriterPort,
  type TransactionRunnerPort,
  type UserWriterPort,
} from '../../src/auth/auth.persistence.js';
import type { CreateUserWithSessionInput } from '../../src/auth/auth.service.js';

const input: CreateUserWithSessionInput = {
  userPublicId: 'user_1' as CreateUserWithSessionInput['userPublicId'],
  sessionPublicId: 'session_1' as CreateUserWithSessionInput['sessionPublicId'],
  familyPublicId: 'family_1',
  email: 'User@Example.dev',
  emailNormalized: 'user@example.dev',
  passwordHash: '$2b$12$123456789012345678901u1234567890123456789012345678901',
  emailFingerprint: Buffer.alloc(32, 1),
  sessionTokenLocator: Buffer.alloc(16, 2),
  sessionTokenHash: Buffer.alloc(32, 3),
  now: 1_800_000_000_000,
  idleExpiresAt: 1_800_028_800_000,
  absoluteExpiresAt: 1_800_604_800_000,
};

const transactionRunner = (): TransactionRunnerPort => ({
  async run(operation) {
    return operation({ connection: Symbol('connection') });
  },
});

test('signup persistence commits user, session, and mandatory audit in one transaction', async () => {
  const calls: string[] = [];
  const users: UserWriterPort = {
    async insert(_transaction, value) {
      calls.push(`user:${value.emailNormalized}`);
      return { kind: 'created', databaseId: '41' };
    },
    async findLoginCandidate() { return null; },
    async lockForLogin() { throw new Error('unexpected login'); },
    async updateLogin() { throw new Error('unexpected login'); },
  };
  const sessions: SessionWriterPort = {
    async insert(_transaction, value) {
      calls.push(`session:${value.userDatabaseId}`);
      assert.equal('credential' in value, false);
    },
  };
  const audit: AuditWriterPort = {
    async writeMandatory(_transaction, value) {
      calls.push(`audit:${value.event}`);
      assert.deepEqual(value.subjectFingerprint, input.emailFingerprint);
    },
  };
  const service = new AuthPersistenceService(transactionRunner(), users, sessions, audit);
  assert.deepEqual(await service.createUserWithSession(input), { kind: 'created', userCreatedAt: input.now });
  assert.deepEqual(calls, ['user:user@example.dev', 'session:41', 'audit:signup_success']);
});

test('signup conflict classification never inserts a session or success audit', async () => {
  for (const conflict of ['email_conflict', 'public_id_collision'] as const) {
    let downstream = 0;
    const users: UserWriterPort = {
      async insert() { return { kind: conflict }; },
      async findLoginCandidate() { return null; },
      async lockForLogin() { throw new Error('unexpected login'); },
      async updateLogin() { throw new Error('unexpected login'); },
    };
    const sessions: SessionWriterPort = { async insert() { downstream += 1; } };
    const audit: AuditWriterPort = { async writeMandatory() { downstream += 1; } };
    const service = new AuthPersistenceService(transactionRunner(), users, sessions, audit);
    assert.deepEqual(await service.createUserWithSession(input), { kind: conflict });
    assert.equal(downstream, 0);
  }
});

test('login commit locks and rechecks the user before session and audit creation', async () => {
  const calls: string[] = [];
  const users: UserWriterPort = {
    async insert() { throw new Error('unexpected signup'); },
    async findLoginCandidate() { return null; },
    async lockForLogin() {
      calls.push('lock-user');
      return { status: 'active', passwordHash: input.passwordHash };
    },
    async updateLogin() { calls.push('update-user'); },
  };
  const sessions: SessionWriterPort = { async insert() { calls.push('insert-session'); } };
  const audit: AuditWriterPort = { async writeMandatory(_transaction, event) { calls.push(`audit:${event.event}`); } };
  const service = new AuthPersistenceService(transactionRunner(), users, sessions, audit);
  assert.deepEqual(await service.commitLogin({
    ...input,
    userDatabaseId: '41',
    expectedPasswordHash: input.passwordHash,
    replacementPasswordHash: null,
  }), { kind: 'created' });
  assert.deepEqual(calls, ['lock-user', 'update-user', 'insert-session', 'audit:login_success']);
});
