import {
  ShareAnalyticsContextParserV1,
  type ShareAnalyticsContextV1,
} from '@sceneboard/board-schema';
import type { ResultSetHeader } from 'mysql2/promise';

import type { PublicShareProjectionRepository } from '../../shares/public-share-projection.repository.js';
import { PublicShareHttpError } from '../../shares/public-share.error.js';
import type { PublicShareResolver } from '../../shares/public-share.resolver.js';
import type { ShareCookieService } from '../../shares/share-cookie.service.js';
import { ShareAnalyticsError } from '../../common/errors/share-analytics.error.js';
import type { CryptoService } from '../../common/security/crypto.service.js';
import { ViewerIdentityService } from './viewer-identity.service.js';

const CONTEXT_TTL_MS = 30 * 60 * 1_000;

export interface ShareAnalyticsContextIssueResult {
  context: ShareAnalyticsContextV1;
  setCookies: readonly string[];
}

export class ShareAnalyticsContextService {
  private readonly identities: ViewerIdentityService;

  constructor(
    crypto: CryptoService,
    private readonly resolver: PublicShareResolver,
    private readonly projections: PublicShareProjectionRepository,
    private readonly shareCookies: ShareCookieService,
    private readonly hostname: string,
  ) {
    this.identities = new ViewerIdentityService(crypto);
  }

  async issue(input: {
    shareId: string;
    cookieHeader?: string | undefined;
  }): Promise<ShareAnalyticsContextIssueResult> {
    const viewer = this.identities.ensure(input.cookieHeader);
    const shareFamily = this.shareCookies.inspectFamilyHeader(input.cookieHeader, this.hostname);
    try {
      return await this.resolver.withPublicShareId({
        shareId: input.shareId,
        shareFamily,
        operation: async (resolved) => {
          const viewContextId = this.newContextId();
          const projection = await this.projections.build(resolved, viewContextId);
          const expiresAt = new Date(resolved.now.valueOf() + CONTEXT_TTL_MS);
          const csrf = this.identities.issueCsrf({
            seed: viewer.seed,
            contextId: viewContextId,
            expiresAt,
            now: resolved.now,
          });
          const [created] = await resolved.connection.execute<ResultSetHeader>(
            `INSERT INTO share_analytics_contexts (
               context_id, board_pk, share_pk, revision_pk, publication_generation,
               access_generation, expires_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              viewContextId,
              resolved.share.boardPk.toString(),
              resolved.share.sharePk.toString(),
              resolved.share.pinnedRevisionPk.toString(),
              resolved.share.publicationGeneration,
              resolved.share.accessGeneration,
              this.mysqlDate(expiresAt),
              resolved.nowSql,
            ],
          );
          if (created.affectedRows !== 1) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          for (let ordinal = 0; ordinal < projection.document.pages.length; ordinal += 1) {
            const page = projection.document.pages[ordinal]!;
            const [pageCreated] = await resolved.connection.execute<ResultSetHeader>(
              `INSERT INTO share_analytics_context_pages (
                 context_id, page_id, page_ordinal, title_label
               ) VALUES (?, ?, ?, ?)`,
              [viewContextId, page.pageId, ordinal, page.title || `Page ${ordinal + 1}`],
            );
            if (pageCreated.affectedRows !== 1)
              throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          }
          const parsed = ShareAnalyticsContextParserV1.parse({
            viewContextId,
            revisionId: projection.revisionId,
            publicationGeneration: projection.publicationGeneration,
            accessGeneration: projection.accessGeneration,
            pageIds: projection.document.pages.map((page) => page.pageId),
            expiresAt: expiresAt.toISOString(),
            csrfToken: csrf.token,
          });
          if (!parsed.ok) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          return {
            context: parsed.data.value,
            setCookies: [...(viewer.setCookie === null ? [] : [viewer.setCookie]), csrf.setCookie],
          };
        },
      });
    } catch (error) {
      if (error instanceof ShareAnalyticsError) throw error;
      if (error instanceof PublicShareHttpError) {
        if (error.status === 503) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
        throw new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE');
      }
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    }
  }

  private newContextId(): string {
    return this.identities.newContextId();
  }

  private mysqlDate(value: Date): string {
    return value.toISOString().replace('T', ' ').replace('Z', '');
  }
}
