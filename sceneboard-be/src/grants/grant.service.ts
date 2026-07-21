import type { SessionRecord } from '../auth/session.service.js';
import { AppError } from '../common/errors/app-error.js';
import { parseGrantId } from '../common/ids/public-id.js';
import type { GrantListQuery } from './grant.dto.js';
import { GrantCursorService } from './grant-cursor.service.js';
import { GrantRepository } from './grant.repository.js';
import type { GrantCredentialResponse, GrantSummary } from './grant.status.js';
import { GrantTokenService } from './grant-token.service.js';

export class GrantService {
  constructor(
    private readonly repository: GrantRepository,
    private readonly cursors: GrantCursorService,
    private readonly tokens: GrantTokenService,
  ) {}

  async list(
    session: SessionRecord,
    query: GrantListQuery,
    now: number,
  ): Promise<{ grants: GrantSummary[]; nextCursor: string | null }> {
    try {
      const result = await this.repository.list({
        ownerUserDatabaseId: session.user.databaseId,
        ownerUserPublicId: session.user.publicId,
        cursor:
          query.cursor === null ? null : this.cursors.parse(session.user.publicId, query.cursor),
        limit: query.limit,
        now,
      });
      return {
        grants: result.grants,
        nextCursor:
          result.nextTuple === null
            ? null
            : this.cursors.issue(session.user.publicId, result.nextTuple),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SERVICE_UNAVAILABLE');
    }
  }

  async revoke(session: SessionRecord, grantIdInput: string, now: number): Promise<void> {
    const result = await this.repository.revoke({
      grantId: parseGrantId(grantIdInput),
      ownerUserDatabaseId: session.user.databaseId,
      ownerUserPublicId: session.user.publicId,
      sessionPublicId: session.publicId,
      now,
    });
    if (result.kind === 'revoked') return;
    if (result.kind === 'not_found') throw new AppError('GRANT_NOT_FOUND');
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async rotate(
    session: SessionRecord,
    grantIdInput: string,
    now: number,
  ): Promise<GrantCredentialResponse> {
    const issued = this.tokens.issue();
    const result = await this.repository.rotate({
      grantId: parseGrantId(grantIdInput),
      ownerUserDatabaseId: session.user.databaseId,
      ownerUserPublicId: session.user.publicId,
      sessionPublicId: session.publicId,
      credentialLocator: issued.locator,
      credentialHash: issued.tokenHash,
      now,
    });
    if (result.kind === 'rotated') {
      return { tokenType: 'Bearer', accessToken: issued.token, grant: result.grant };
    }
    if (result.kind === 'not_found') throw new AppError('GRANT_NOT_FOUND');
    if (result.kind === 'not_active') throw new AppError('GRANT_NOT_ACTIVE');
    throw new AppError('SERVICE_UNAVAILABLE');
  }
}
