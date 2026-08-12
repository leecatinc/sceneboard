import {
  PublicContextIdParserV1,
  PublicShareStateParserV1,
  type PublicShareStateV1,
} from '@sceneboard/board-schema';

import type { AppEnvironment } from '../config/env.schema.js';
import type { PublicContextCookieService } from './public-context-cookie.service.js';
import type { PublicContextStore } from './public-context.store.js';
import { PublicShareHttpError } from './public-share.error.js';
import type { PublicShareProjectionRepository } from './public-share-projection.repository.js';
import type { PublicShareResolver } from './public-share.resolver.js';
import type { ShareCookieService } from './share-cookie.service.js';

export interface PublicProjectionResult {
  state: PublicShareStateV1;
  setCookies: readonly string[];
}

export class PublicShareProjectionService {
  private readonly hostname: string;

  constructor(
    private readonly resolver: PublicShareResolver,
    private readonly projections: PublicShareProjectionRepository,
    private readonly contexts: PublicContextStore,
    private readonly contextCookies: PublicContextCookieService,
    private readonly shareCookies: ShareCookieService,
    environment: AppEnvironment,
  ) {
    this.hostname = new URL(environment.browserOrigin).hostname;
  }

  async initial(input: {
    shareToken: string;
    cookieHeader?: string | undefined;
  }): Promise<PublicProjectionResult> {
    const shareFamily = this.shareCookies.inspectFamilyHeader(input.cookieHeader, this.hostname);
    const contextFamily = this.contextCookies.inspect(input.cookieHeader, this.hostname);
    const resolution = await this.resolver.withInitial({
      shareToken: input.shareToken,
      shareFamily,
      operation: async (resolved) => {
        const contextId = this.contexts.newContextId();
        const validUntil = new Date(resolved.now.valueOf() + 60_000);
        const projection = await this.projections.build(resolved, contextId);
        const persisted = await this.contexts.persist({
          contextId,
          cookie: contextFamily,
          hostname: this.hostname,
          now: resolved.now,
          validUntil,
          tuple: {
            sharePk: resolved.share.sharePk,
            boardPk: resolved.share.boardPk,
            revisionPk: resolved.share.pinnedRevisionPk,
            publicationGeneration: resolved.share.publicationGeneration,
            accessGeneration: resolved.share.accessGeneration,
          },
        });
        return {
          state: this.parseState({
            state: 'ready',
            projection,
            context: { contextId, validUntil: validUntil.toISOString() },
          }),
          setCookies: persisted.setCookie === null ? [] : [persisted.setCookie],
        };
      },
    });
    if (resolution.kind === 'ready') return resolution.value;
    const csrf = this.shareCookies.ensureShareCsrfCookie({
      hostname: this.hostname,
      cookieHeader: input.cookieHeader,
      nowSeconds: Math.floor(resolution.now.valueOf() / 1_000),
    });
    const setCookies: string[] = [];
    if (resolution.clearInvalidFamily)
      setCookies.push(this.shareCookies.clearFamily(this.hostname));
    if (csrf.setCookie !== null) setCookies.push(csrf.setCookie);
    return {
      state: this.parseState({ state: 'password-required', csrfToken: csrf.csrfToken }),
      setCookies,
    };
  }

  async revalidate(input: {
    contextId: string;
    cookieHeader?: string | undefined;
  }): Promise<PublicProjectionResult> {
    const parsedContextId = PublicContextIdParserV1.parse(input.contextId);
    if (!parsedContextId.ok) throw new PublicShareHttpError(400);
    const contextFamily = this.contextCookies.inspect(input.cookieHeader, this.hostname);
    if (contextFamily.kind === 'invalid') throw new PublicShareHttpError(400);
    if (contextFamily.kind === 'absent') throw new PublicShareHttpError(404);
    const stored = await this.contexts.read({
      familyDigest: contextFamily.digest,
      contextId: parsedContextId.data.value,
    });
    if (stored === null) throw new PublicShareHttpError(404);
    const shareFamily = this.shareCookies.inspectFamilyHeader(input.cookieHeader, this.hostname);
    return this.resolver.withContext({
      context: stored,
      shareFamily,
      operation: async (resolved) => {
        const contextId = this.contexts.newContextId();
        const validUntil = new Date(resolved.now.valueOf() + 60_000);
        const projection = await this.projections.build(resolved, contextId);
        const persisted = await this.contexts.persist({
          contextId,
          cookie: contextFamily,
          hostname: this.hostname,
          now: resolved.now,
          validUntil,
          tuple: {
            sharePk: resolved.share.sharePk,
            boardPk: resolved.share.boardPk,
            revisionPk: resolved.share.pinnedRevisionPk,
            publicationGeneration: resolved.share.publicationGeneration,
            accessGeneration: resolved.share.accessGeneration,
          },
        });
        return {
          state: this.parseState({
            state: 'ready',
            projection,
            context: { contextId, validUntil: validUntil.toISOString() },
          }),
          setCookies: persisted.setCookie === null ? [] : [persisted.setCookie],
        };
      },
    });
  }

  private parseState(input: unknown): PublicShareStateV1 {
    const parsed = PublicShareStateParserV1.parse(input);
    if (!parsed.ok) throw new PublicShareHttpError(503);
    return parsed.data.value;
  }
}
