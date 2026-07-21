import type { ClientGrantCapabilityV1 } from '@sceneboard/board-schema';

import { BoardApiTransport, isObject } from './board-api-core';
import type {
  ApiResult,
  CreatedPairing,
  GrantSummary,
  LifecyclePermission,
  PairingDecision,
  PairingOwnerState,
  PairingOwnerStatus,
  RotatedGrantCredential,
} from './board-api-types';

export class BoardConnectionApi extends BoardApiTransport {
  async listActivePairings(signal?: AbortSignal): Promise<ApiResult<PairingOwnerStatus[]>> {
    const result = await this.coordinator.dispatchShared({
      path: '/api/v1/pairings/active',
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    if (
      !result.value.response.ok ||
      !isObject(result.value.body) ||
      !Array.isArray(result.value.body.pairings)
    ) {
      return { kind: 'api_error', status: result.value.response.status };
    }
    return { kind: 'ok', value: result.value.body.pairings.map(parsePairingOwnerStatus) };
  }

  async listGrants(
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ grants: GrantSummary[]; nextCursor: string | null }>> {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/grants${query}`,
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    const body = result.value.body;
    if (
      !result.value.response.ok ||
      !isObject(body) ||
      !Array.isArray(body.grants) ||
      !(body.nextCursor === null || typeof body.nextCursor === 'string')
    ) {
      return { kind: 'api_error', status: result.value.response.status };
    }
    return {
      kind: 'ok',
      value: { grants: body.grants.map(parseGrantSummary), nextCursor: body.nextCursor },
    };
  }

  async createPairing(csrfToken: string): Promise<ApiResult<CreatedPairing>> {
    const result = await this.coordinator.dispatchShared({
      path: '/api/v1/pairings',
      method: 'POST',
      body: {},
      csrfToken,
    });
    if (result.kind !== 'ok') return result;
    if (result.value.response.status !== 201)
      return { kind: 'api_error', status: result.value.response.status };
    return { kind: 'ok', value: parseCreatedPairing(result.value.body) };
  }

  async decidePairing(
    pairingId: string,
    csrfToken: string,
    decision: PairingDecision,
  ): Promise<ApiResult<PairingOwnerStatus>> {
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/pairings/${encodeURIComponent(pairingId)}/decision`,
      method: 'POST',
      body: decision,
      csrfToken,
    });
    if (result.kind !== 'ok') return result;
    if (!result.value.response.ok)
      return { kind: 'api_error', status: result.value.response.status };
    return { kind: 'ok', value: parsePairingOwnerStatus(result.value.body) };
  }

  async cancelPairing(pairingId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.emptyMutation(
      `/api/v1/pairings/${encodeURIComponent(pairingId)}`,
      'DELETE',
      csrfToken,
    );
  }

  async revokeGrant(grantId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.emptyMutation(`/api/v1/grants/${encodeURIComponent(grantId)}`, 'DELETE', csrfToken);
  }

  async rotateGrant(
    grantId: string,
    csrfToken: string,
  ): Promise<ApiResult<RotatedGrantCredential>> {
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/grants/${encodeURIComponent(grantId)}/rotate`,
      method: 'POST',
      body: {},
      csrfToken,
    });
    if (result.kind !== 'ok') return result;
    const body = result.value.body;
    if (
      !result.value.response.ok ||
      !isObject(body) ||
      body.tokenType !== 'Bearer' ||
      typeof body.accessToken !== 'string'
    )
      return { kind: 'api_error', status: result.value.response.status };
    return {
      kind: 'ok',
      value: {
        tokenType: 'Bearer',
        accessToken: body.accessToken,
        grant: parseGrantSummary(body.grant),
      },
    };
  }
}

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new TypeError('invalid string array');
  return [...value];
};

const nullableString = (value: unknown): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError('invalid nullable string');
};

const parseClient = (value: unknown): PairingOwnerStatus['client'] => {
  if (value === null) return null;
  if (
    !isObject(value) ||
    typeof value.clientId !== 'string' ||
    typeof value.clientName !== 'string' ||
    typeof value.installationFingerprint !== 'string'
  ) {
    throw new TypeError('invalid pairing client');
  }
  return {
    clientId: value.clientId,
    clientName: value.clientName,
    installationFingerprint: value.installationFingerprint,
  };
};

const parsePairingOwnerStatus = (value: unknown): PairingOwnerStatus => {
  if (!isObject(value) || typeof value.pairingId !== 'string' || typeof value.state !== 'string')
    throw new TypeError('invalid pairing');
  const client = parseClient(value.client);
  return {
    pairingId: value.pairingId,
    state: value.state as PairingOwnerState,
    createdAt: String(value.createdAt),
    codeExpiresAt: String(value.codeExpiresAt),
    decisionExpiresAt: nullableString(value.decisionExpiresAt),
    redeemExpiresAt: nullableString(value.redeemExpiresAt),
    client,
    requestedScopes: stringArray(value.requestedScopes) as ClientGrantCapabilityV1[],
    requestedLifecyclePermissions: stringArray(
      value.requestedLifecyclePermissions,
    ) as LifecyclePermission[],
    approvedScopes:
      value.approvedScopes === null
        ? null
        : (stringArray(value.approvedScopes) as ClientGrantCapabilityV1[]),
    approvedLifecyclePermissions:
      value.approvedLifecyclePermissions === null
        ? null
        : (stringArray(value.approvedLifecyclePermissions) as LifecyclePermission[]),
    boardIds: value.boardIds === null ? null : stringArray(value.boardIds),
    lifetime: value.lifetime === null ? null : (value.lifetime as 'session' | 'persistent'),
    decidedAt: nullableString(value.decidedAt),
  };
};

const parseGrantSummary = (value: unknown): GrantSummary => {
  if (!isObject(value) || typeof value.grantId !== 'string') throw new TypeError('invalid grant');
  const client = parseClient(value.client);
  if (client === null) throw new TypeError('grant client is required');
  return {
    grantId: value.grantId,
    client,
    scopes: stringArray(value.scopes) as ClientGrantCapabilityV1[],
    lifecyclePermissions: stringArray(value.lifecyclePermissions) as LifecyclePermission[],
    boardIds: stringArray(value.boardIds),
    lifetime: value.lifetime as 'session' | 'persistent',
    status: value.status as GrantSummary['status'],
    createdAt: String(value.createdAt),
    activatedAt: nullableString(value.activatedAt),
    lastUsedAt: nullableString(value.lastUsedAt),
    expiresAt: String(value.expiresAt),
    revokedAt: nullableString(value.revokedAt),
  };
};

const parseCreatedPairing = (value: unknown): CreatedPairing => {
  if (
    !isObject(value) ||
    typeof value.pairingId !== 'string' ||
    typeof value.code !== 'string' ||
    value.state !== 'created' ||
    typeof value.codeExpiresAt !== 'string'
  )
    throw new TypeError('invalid pairing creation response');
  return {
    pairingId: value.pairingId,
    code: value.code,
    state: 'created',
    codeExpiresAt: value.codeExpiresAt,
  };
};
