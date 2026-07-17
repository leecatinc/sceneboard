import type { PasswordChangeRequest } from './auth.dto.js';
import type { PasswordPort } from './auth.service.js';
import type { SessionRecord } from './session.service.js';
import { AppError } from '../common/errors/app-error.js';

export interface PasswordChangeCandidate {
  passwordHash: string;
  status: 'active' | 'disabled';
}

export interface CommitPasswordChangeInput {
  userDatabaseId: string;
  userPublicId: string;
  currentSessionDatabaseId: string;
  currentSessionPublicId: string;
  currentFamilyPublicId: string;
  expectedPasswordHash: string;
  replacementPasswordHash: string;
  now: number;
}

export type CommitPasswordChangeResult =
  | { kind: 'changed'; otherSessionFamiliesRevoked: number }
  | { kind: 'disabled' | 'session_stale' | 'stale_hash' };

export interface PasswordChangePersistence {
  findCandidate(userDatabaseId: string): Promise<PasswordChangeCandidate | null>;
  commit(input: CommitPasswordChangeInput): Promise<CommitPasswordChangeResult>;
}

export class PasswordChangeService {
  constructor(
    private readonly persistence: PasswordChangePersistence,
    private readonly passwords: PasswordPort,
  ) {}

  async change(
    session: SessionRecord,
    request: PasswordChangeRequest,
    now: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = performance.now();
    this.passwords.validate(request.newPassword);

    let candidate: PasswordChangeCandidate | null;
    try {
      candidate = await this.persistence.findCandidate(session.user.databaseId);
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    const passwordHash = candidate?.passwordHash ?? this.passwords.dummyHash();
    const verified = await this.passwords.verify(request.currentPassword, passwordHash);
    if (!candidate || candidate.status !== 'active') {
      await this.passwords.padFailure(startedAt, signal);
      throw new AppError('AUTH_SESSION_REVOKED');
    }
    if (!verified) {
      await this.passwords.padFailure(startedAt, signal);
      throw new AppError('AUTH_CURRENT_PASSWORD_INVALID');
    }
    if (request.currentPassword === request.newPassword) throw new AppError('AUTH_PASSWORD_UNCHANGED');

    const replacementPasswordHash = await this.passwords.hash(request.newPassword);
    let result: CommitPasswordChangeResult;
    try {
      result = await this.persistence.commit({
        userDatabaseId: session.user.databaseId,
        userPublicId: session.user.publicId,
        currentSessionDatabaseId: session.databaseId,
        currentSessionPublicId: session.publicId,
        currentFamilyPublicId: session.familyPublicId,
        expectedPasswordHash: candidate.passwordHash,
        replacementPasswordHash,
        now,
      });
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    if (result.kind === 'stale_hash') throw new AppError('AUTH_CURRENT_PASSWORD_INVALID');
    if (result.kind !== 'changed') throw new AppError('AUTH_SESSION_REVOKED');
  }
}
