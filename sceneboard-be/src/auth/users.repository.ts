import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type {
  PersistenceTransaction,
  UserInsertResult,
  UserWriterPort,
} from './auth.persistence.js';
import type { CreateUserWithSessionInput, LoginCandidate } from './auth.service.js';
import { MysqlService } from '../database/mysql.service.js';

interface UserRow extends RowDataPacket {
  id: string;
  publicId: string;
  email: string;
  passwordHash: string;
  status: number;
  createdAt: string;
}

const connectionOf = (transaction: PersistenceTransaction): PoolConnection =>
  transaction.connection as PoolConnection;

const isoTimestamp = (value: string): string => {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf())) throw new Error('database returned an invalid timestamp');
  return parsed.toISOString();
};

const duplicateConstraint = (error: unknown): string | null => {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'ER_DUP_ENTRY'
  )
    return null;
  return 'message' in error && typeof error.message === 'string' ? error.message : '';
};

@Injectable()
export class UsersRepository implements UserWriterPort {
  constructor(@Inject(MysqlService) private readonly mysql: MysqlService) {}

  async insert(
    transaction: PersistenceTransaction,
    input: CreateUserWithSessionInput,
  ): Promise<UserInsertResult> {
    try {
      const [result] = await connectionOf(transaction).execute<ResultSetHeader>(
        `
        INSERT INTO users (
          public_id, email_normalized, email, password_hash, status,
          password_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `,
        [
          input.userPublicId,
          input.emailNormalized,
          input.email,
          input.passwordHash,
          new Date(input.now),
          new Date(input.now),
          new Date(input.now),
        ],
      );
      return { kind: 'created', databaseId: String(result.insertId) };
    } catch (error) {
      const constraint = duplicateConstraint(error);
      if (constraint === null) throw error;
      if (constraint.includes('uq_users_email')) return { kind: 'email_conflict' };
      return { kind: 'public_id_collision' };
    }
  }

  async findLoginCandidate(emailNormalized: string): Promise<LoginCandidate | null> {
    return this.mysql.withConnection(async (connection) => {
      const [rows] = await connection.execute<UserRow[]>(
        `
        SELECT
          CAST(id AS CHAR) AS id,
          public_id AS publicId,
          email,
          password_hash AS passwordHash,
          status,
          created_at AS createdAt
        FROM users
        WHERE email_normalized = ?
        LIMIT 1
      `,
        [emailNormalized],
      );
      return rows[0] ? this.mapCandidate(rows[0]) : null;
    });
  }

  async lockForLogin(
    transaction: PersistenceTransaction,
    databaseId: string,
  ): Promise<{
    status: 'active' | 'disabled';
    passwordHash: string;
  } | null> {
    const [rows] = await connectionOf(transaction).execute<
      Array<RowDataPacket & { status: number; passwordHash: string }>
    >(
      `
      SELECT status, password_hash AS passwordHash
      FROM users
      WHERE id = ?
      FOR UPDATE
    `,
      [databaseId],
    );
    const row = rows[0];
    if (!row) return null;
    return { status: row.status === 1 ? 'active' : 'disabled', passwordHash: row.passwordHash };
  }

  async updateLogin(
    transaction: PersistenceTransaction,
    input: {
      databaseId: string;
      expectedPasswordHash: string;
      replacementPasswordHash: string | null;
      now: number;
    },
  ): Promise<void> {
    const connection = connectionOf(transaction);
    if (input.replacementPasswordHash === null) {
      await connection.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [
        new Date(input.now),
        input.databaseId,
      ]);
      return;
    }
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE users
      SET password_hash = ?, password_updated_at = ?, last_login_at = ?
      WHERE id = ? AND password_hash = ?
    `,
      [
        input.replacementPasswordHash,
        new Date(input.now),
        new Date(input.now),
        input.databaseId,
        input.expectedPasswordHash,
      ],
    );
    if (result.affectedRows !== 1)
      throw new Error('locked user password hash changed unexpectedly');
  }

  private mapCandidate(row: UserRow): LoginCandidate {
    if (row.status !== 1 && row.status !== 2)
      throw new Error('database returned an invalid user status');
    return {
      id: row.id,
      publicId: row.publicId,
      email: row.email,
      passwordHash: row.passwordHash,
      status: row.status === 1 ? 'active' : 'disabled',
      createdAt: isoTimestamp(row.createdAt),
    };
  }
}
