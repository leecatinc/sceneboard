import {
  type ActorContextV1,
  type GrantId,
  normalizeActorContextV1,
} from '@sceneboard/board-schema';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError } from '../common/errors/app-error.js';
import type {
  ResolvedBoardPrincipalV1,
  ResolvedMcpGrantProjectionV1,
} from './board-access.policy.js';
import { D2_SCOPE_CATALOG, scopeValuesFromMask } from './scope-map.js';
import { GrantTokenService } from './grant-token.service.js';

export interface GrantPrincipalRecord {
  ownerUserDatabaseId: string;
  grantDatabaseId: string;
  credentialDatabaseId: string;
  clientPublicId: string;
  grantPublicId: string;
  sourceFamilyPublicId: string | null;
  scopeMask: number;
  connectionGrant?: ResolvedMcpGrantProjectionV1;
}

export interface GrantPrincipalPersistence {
  resolve(input: {
    locator: Buffer;
    tokenHash: Buffer;
    now: number;
  }): Promise<GrantPrincipalRecord | null>;
}

const hasSameScopes = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((scope) => right.includes(scope));

export class ActorContextService {
  constructor(
    private readonly persistence: GrantPrincipalPersistence,
    private readonly tokens: GrantTokenService,
  ) {}

  resolveUser(session: SessionRecord): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> {
    return {
      kind: 'user',
      actor: this.normalize({
        principalKind: 'user',
        principalId: session.user.publicId,
        grantId: null,
        scopes: D2_SCOPE_CATALOG,
      }),
      userPk: databaseId(session.user.databaseId),
      sessionPk: databaseId(session.databaseId),
      familyPublicId: session.familyPublicId,
    };
  }

  async resolveMcp(
    authorization: string | undefined,
    now: number,
  ): Promise<Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }>> {
    const token = exactBearerToken(authorization);
    const credential = this.tokens.parseAndHash(token);
    const resolved = await this.persistence.resolve({ ...credential, now });
    if (resolved === null) throw new AppError('UNAUTHENTICATED');
    if (resolved.scopeMask < 1) throw new AppError('SERVICE_UNAVAILABLE');
    const actor = this.normalize({
      principalKind: 'mcp_client',
      principalId: resolved.clientPublicId,
      grantId: resolved.grantPublicId,
      scopes: scopeValuesFromMask(resolved.scopeMask),
    });
    if (actor.grantId === null) throw new AppError('SERVICE_UNAVAILABLE');
    const grantId: GrantId = actor.grantId;
    if (
      resolved.connectionGrant !== undefined &&
      (resolved.connectionGrant.grantId !== grantId ||
        !hasSameScopes(resolved.connectionGrant.scopes, actor.scopes))
    )
      throw new AppError('SERVICE_UNAVAILABLE');
    return {
      kind: 'mcp',
      actor,
      ownerUserPk: databaseId(resolved.ownerUserDatabaseId),
      grantPk: databaseId(resolved.grantDatabaseId),
      credentialPk: databaseId(resolved.credentialDatabaseId),
      grantId,
      sourceFamilyPublicId: resolved.sourceFamilyPublicId,
      ...(resolved.connectionGrant === undefined
        ? {}
        : { connectionGrant: resolved.connectionGrant }),
    };
  }

  private normalize(candidate: unknown): ActorContextV1 {
    const result = normalizeActorContextV1(candidate);
    if (!result.ok) throw new AppError('SERVICE_UNAVAILABLE');
    return result.data.value;
  }
}

const exactBearerToken = (authorization: string | undefined): string => {
  if (authorization === undefined) throw new AppError('UNAUTHENTICATED');
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match?.[1] === undefined) throw new AppError('UNAUTHENTICATED');
  return match[1];
};

const databaseId = (value: string): bigint => {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw new AppError('SERVICE_UNAVAILABLE');
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 18_446_744_073_709_551_615n)
    throw new AppError('SERVICE_UNAVAILABLE');
  return parsed;
};
