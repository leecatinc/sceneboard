import type {
  AuthPersistence,
  CommitLoginInput,
  CreateUserWithSessionInput,
  LoginCandidate,
} from './auth.service.js';
import type { AuditEventName } from '../audit/audit-events.js';

export interface PersistenceTransaction {
  connection: unknown;
}

export interface TransactionRunnerPort {
  run<Value>(operation: (transaction: PersistenceTransaction) => Promise<Value>): Promise<Value>;
}

export type UserInsertResult =
  | { kind: 'created'; databaseId: string }
  | { kind: 'email_conflict' | 'public_id_collision' };

export interface UserWriterPort {
  insert(
    transaction: PersistenceTransaction,
    input: CreateUserWithSessionInput,
  ): Promise<UserInsertResult>;
  findLoginCandidate(emailNormalized: string): Promise<LoginCandidate | null>;
  lockForLogin(
    transaction: PersistenceTransaction,
    databaseId: string,
  ): Promise<{
    status: 'active' | 'disabled';
    passwordHash: string;
  } | null>;
  updateLogin(
    transaction: PersistenceTransaction,
    input: {
      databaseId: string;
      expectedPasswordHash: string;
      replacementPasswordHash: string | null;
      now: number;
    },
  ): Promise<void>;
}

export interface SessionWriterPort {
  insert(
    transaction: PersistenceTransaction,
    input: {
      userDatabaseId: string;
      sessionPublicId: CommitLoginInput['sessionPublicId'];
      familyPublicId: string;
      sessionTokenLocator: Buffer;
      sessionTokenHash: Buffer;
      now: number;
      idleExpiresAt: number;
      absoluteExpiresAt: number;
    },
  ): Promise<void>;
}

export interface AuditWriterPort {
  writeMandatory(
    transaction: PersistenceTransaction,
    input: {
      event: AuditEventName;
      userPublicId: string | null;
      sessionPublicId: string | null;
      actorPublicId?: string | null;
      clientPublicId?: string | null;
      grantPublicId?: string | null;
      pairingPublicId?: string | null;
      subjectFingerprint: Buffer | null;
      metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
}

export class AuthPersistenceService implements AuthPersistence {
  constructor(
    private readonly transactions: TransactionRunnerPort,
    private readonly users: UserWriterPort,
    private readonly sessions: SessionWriterPort,
    private readonly audit: AuditWriterPort,
  ) {}

  async createUserWithSession(
    input: CreateUserWithSessionInput,
  ): Promise<
    { kind: 'created'; userCreatedAt: number } | { kind: 'email_conflict' | 'public_id_collision' }
  > {
    return this.transactions.run(async (transaction) => {
      const created = await this.users.insert(transaction, input);
      if (created.kind !== 'created') return created;
      await this.sessions.insert(transaction, {
        userDatabaseId: created.databaseId,
        ...this.sessionInput(input),
      });
      await this.audit.writeMandatory(transaction, {
        event: 'signup_success',
        userPublicId: input.userPublicId,
        sessionPublicId: input.sessionPublicId,
        subjectFingerprint: Buffer.from(input.emailFingerprint),
      });
      return { kind: 'created', userCreatedAt: input.now };
    });
  }

  async findLoginCandidate(emailNormalized: string): Promise<LoginCandidate | null> {
    return this.users.findLoginCandidate(emailNormalized);
  }

  async commitLogin(
    input: CommitLoginInput,
  ): Promise<{ kind: 'created' } | { kind: 'disabled' | 'stale_hash' | 'public_id_collision' }> {
    return this.transactions.run(async (transaction) => {
      const locked = await this.users.lockForLogin(transaction, input.userDatabaseId);
      if (!locked || locked.passwordHash !== input.expectedPasswordHash)
        return { kind: 'stale_hash' };
      if (locked.status === 'disabled') return { kind: 'disabled' };
      try {
        await this.users.updateLogin(transaction, {
          databaseId: input.userDatabaseId,
          expectedPasswordHash: input.expectedPasswordHash,
          replacementPasswordHash: input.replacementPasswordHash,
          now: input.now,
        });
        await this.sessions.insert(transaction, {
          userDatabaseId: input.userDatabaseId,
          ...this.sessionInput(input),
        });
      } catch (error) {
        if (isDuplicateKey(error)) return { kind: 'public_id_collision' };
        throw error;
      }
      await this.audit.writeMandatory(transaction, {
        event: 'login_success',
        userPublicId: input.userPublicId,
        sessionPublicId: input.sessionPublicId,
        subjectFingerprint: Buffer.from(input.emailFingerprint),
        metadata: { workFactorUpgraded: input.replacementPasswordHash !== null },
      });
      return { kind: 'created' };
    });
  }

  private sessionInput(input: CreateUserWithSessionInput | CommitLoginInput) {
    return {
      sessionPublicId: input.sessionPublicId,
      familyPublicId: input.familyPublicId,
      sessionTokenLocator: Buffer.from(input.sessionTokenLocator),
      sessionTokenHash: Buffer.from(input.sessionTokenHash),
      now: input.now,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
    };
  }
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';
