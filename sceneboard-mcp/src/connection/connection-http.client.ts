import {
  BoardCapabilitiesParserV1,
  BoardErrorParserV1,
  BoardOperationResultParserV1,
  CLIENT_GRANT_CAPABILITIES_V1,
  GlobalIdStringParserV1,
  GrantIdParserV1,
  PrincipalIdParserV1,
  type BoardCapabilitiesV1,
  type BoardErrorV1,
  type BoardId,
  type BoardSummaryV1,
  type ClientGrantCapabilityV1,
  type GrantId,
  type PrincipalId,
} from '@sceneboard/board-schema';
import { BoardSdkHttpClient } from '@sceneboard/board-sdk/http';

const TOKEN_PATTERN = /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LIFECYCLE_PERMISSIONS = ['board.create', 'board.archive'] as const;

export type SafeAuthorizedConnectionV1 = {
  principal: {
    principalKind: 'mcp_client';
    principalId: PrincipalId;
    grantId: GrantId;
  };
  grant: {
    grantId: GrantId;
    client: {
      clientId: string;
      clientName: string;
      installationFingerprint: string;
    };
    scopes: ClientGrantCapabilityV1[];
    lifecyclePermissions: Array<(typeof LIFECYCLE_PERMISSIONS)[number]>;
    boardIds: BoardId[];
    lifetime: 'session' | 'persistent';
    status: 'active';
    activatedAt: string;
    expiresAt: string;
  };
  selectedBoard: null | {
    board: BoardSummaryV1;
    capabilities: BoardCapabilitiesV1;
    browserPresence: 'online' | 'offline' | 'unknown';
  };
  versions: {
    mcpServer: '0.0.0';
    boardProtocol: '1.0.0';
    api: 'v1';
  };
};

export type ConnectionHttpLocalErrorV1 =
  | { code: 'CANCELLED'; retryable: false }
  | { code: 'TIMEOUT'; retryable: true; timeoutMs: number }
  | { code: 'TRANSPORT_ERROR'; retryable: true; phase: 'connect' | 'request' | 'response' }
  | {
      code: 'RESPONSE_INVALID';
      retryable: false;
      reason:
        | 'status'
        | 'content_type'
        | 'utf8'
        | 'json'
        | 'duplicate_member'
        | 'schema'
        | 'correlation'
        | 'body_too_large';
    };

export type ConnectionHttpResultV1 =
  | { ok: true; value: SafeAuthorizedConnectionV1 }
  | { ok: false; source: 'board'; error: BoardErrorV1 }
  | { ok: false; source: 'local'; error: ConnectionHttpLocalErrorV1 };

export type ConnectionHttpClientOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  logger: {
    log(event: {
      route: string;
      attempt: number;
      durationMs: number;
      requestId: string;
      resultCode: string;
    }): void;
  };
};

const exactRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null;
};

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value;
};

const exactCatalogSubset = <Value extends string>(
  value: unknown,
  catalog: readonly Value[],
  minimum: number,
): Value[] | null => {
  if (!Array.isArray(value) || value.length < minimum || value.length > catalog.length) return null;
  const result: Value[] = [];
  let lastIndex = -1;
  for (const item of value) {
    const index = typeof item === 'string' ? catalog.indexOf(item as Value) : -1;
    if (index <= lastIndex) return null;
    lastIndex = index;
    result.push(item as Value);
  }
  return result;
};

const parseGlobalId = (value: unknown): string | null => {
  const parsed = GlobalIdStringParserV1.parse(value);
  return parsed.ok ? parsed.data.value : null;
};

const parseConnection = (
  value: unknown,
  requestId: string,
  boardId: string | null,
): SafeAuthorizedConnectionV1 | null => {
  const root = exactRecord(value, ['principal', 'grant', 'selectedBoard', 'versions']);
  if (root === null) return null;
  const principal = exactRecord(root.principal, ['principalKind', 'principalId', 'grantId']);
  const grant = exactRecord(root.grant, [
    'grantId',
    'client',
    'scopes',
    'lifecyclePermissions',
    'boardIds',
    'lifetime',
    'status',
    'activatedAt',
    'expiresAt',
  ]);
  const versions = exactRecord(root.versions, ['mcpServer', 'boardProtocol', 'api']);
  if (
    principal === null ||
    grant === null ||
    versions === null ||
    principal.principalKind !== 'mcp_client' ||
    versions.mcpServer !== '0.0.0' ||
    versions.boardProtocol !== '1.0.0' ||
    versions.api !== 'v1'
  )
    return null;
  const parsedPrincipalId = PrincipalIdParserV1.parse(principal.principalId);
  const parsedPrincipalGrantId = GrantIdParserV1.parse(principal.grantId);
  const parsedGrantId = GrantIdParserV1.parse(grant.grantId);
  const client = exactRecord(grant.client, ['clientId', 'clientName', 'installationFingerprint']);
  const clientId = client === null ? null : parseGlobalId(client.clientId);
  if (
    !parsedPrincipalId.ok ||
    !parsedPrincipalGrantId.ok ||
    !parsedGrantId.ok ||
    client === null ||
    clientId === null ||
    parsedPrincipalGrantId.data.value !== parsedGrantId.data.value ||
    parsedPrincipalId.data.value !== clientId ||
    typeof client.clientName !== 'string' ||
    [...client.clientName].length < 1 ||
    [...client.clientName].length > 100 ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(client.clientName) ||
    typeof client.installationFingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(client.installationFingerprint)
  )
    return null;
  const scopes = exactCatalogSubset(grant.scopes, CLIENT_GRANT_CAPABILITIES_V1, 1);
  const lifecyclePermissions = exactCatalogSubset(
    grant.lifecyclePermissions,
    LIFECYCLE_PERMISSIONS,
    0,
  );
  if (
    scopes === null ||
    lifecyclePermissions === null ||
    !Array.isArray(grant.boardIds) ||
    grant.boardIds.length > 50 ||
    (grant.boardIds.length === 0 &&
      (!scopes.includes('board.write') || !lifecyclePermissions.includes('board.create'))) ||
    (grant.lifetime !== 'session' && grant.lifetime !== 'persistent') ||
    grant.status !== 'active' ||
    !validTimestamp(grant.activatedAt) ||
    !validTimestamp(grant.expiresAt)
  )
    return null;
  const parsedBoardIds: BoardId[] = [];
  let previousBoardId = '';
  for (const candidate of grant.boardIds) {
    const parsed = parseGlobalId(candidate);
    if (parsed === null || parsed <= previousBoardId) return null;
    previousBoardId = parsed;
    parsedBoardIds.push(parsed as BoardId);
  }
  let selectedBoard: SafeAuthorizedConnectionV1['selectedBoard'] = null;
  if (root.selectedBoard !== null) {
    if (boardId === null) return null;
    const selected = exactRecord(root.selectedBoard, ['board', 'capabilities', 'browserPresence']);
    if (
      selected === null ||
      !['online', 'offline', 'unknown'].includes(String(selected.browserPresence))
    )
      return null;
    const boardResult = BoardOperationResultParserV1.parse({
      protocolVersion: 1,
      type: 'board.operation.result',
      requestId,
      replayed: false,
      result: { type: 'board.list', boards: [selected.board], nextCursor: null },
    });
    const capabilities = BoardCapabilitiesParserV1.parse(selected.capabilities);
    if (!boardResult.ok || boardResult.data.value.result.type !== 'board.list' || !capabilities.ok)
      return null;
    const board = boardResult.data.value.result.boards[0];
    if (board === undefined || board.boardId !== boardId || !parsedBoardIds.includes(board.boardId))
      return null;
    selectedBoard = {
      board,
      capabilities: capabilities.data.value,
      browserPresence: selected.browserPresence as 'online' | 'offline' | 'unknown',
    };
  } else if (boardId !== null) return null;
  return {
    principal: {
      principalKind: 'mcp_client',
      principalId: parsedPrincipalId.data.value,
      grantId: parsedPrincipalGrantId.data.value,
    },
    grant: {
      grantId: parsedGrantId.data.value,
      client: {
        clientId,
        clientName: client.clientName,
        installationFingerprint: client.installationFingerprint,
      },
      scopes,
      lifecyclePermissions,
      boardIds: parsedBoardIds,
      lifetime: grant.lifetime,
      status: 'active',
      activatedAt: grant.activatedAt,
      expiresAt: grant.expiresAt,
    },
    selectedBoard,
    versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
  };
};

const local = (error: ConnectionHttpLocalErrorV1): ConnectionHttpResultV1 => ({
  ok: false,
  source: 'local',
  error,
});

export class ConnectionHttpClientV1 {
  constructor(private readonly options: ConnectionHttpClientOptionsV1) {}

  async get(
    boardId: string | null,
    requestId: string,
    accessToken: string,
    outerSignal?: AbortSignal,
  ): Promise<ConnectionHttpResultV1> {
    if (!TOKEN_PATTERN.test(accessToken))
      return local({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'connect' });
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal =
      outerSignal === undefined ? timeoutSignal : AbortSignal.any([outerSignal, timeoutSignal]);
    if (signal.aborted) return local({ code: 'CANCELLED', retryable: false });
    const query = new URLSearchParams({ requestId });
    if (boardId !== null) query.set('boardId', boardId);
    const url = new URL('/api/v1/mcp/connection', this.options.baseUrl);
    url.search = query.toString();
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal,
      });
    } catch {
      if (outerSignal?.aborted) return local({ code: 'CANCELLED', retryable: false });
      if (timeoutSignal.aborted)
        return local({ code: 'TIMEOUT', retryable: true, timeoutMs: this.options.timeoutMs });
      return local({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'request' });
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'status' });
    }
    if (response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8') {
      await response.body?.cancel().catch(() => undefined);
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'content_type' });
    }
    if (
      response.headers.get('cache-control') !== 'no-store, private' ||
      response.headers.get('pragma') !== 'no-cache' ||
      response.headers.get('vary') !== 'Origin, Cookie, Authorization'
    ) {
      await response.body?.cancel().catch(() => undefined);
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'schema' });
    }
    const bytes = await BoardSdkHttpClient.readBoundedResponseBodyV1(
      response,
      response.status === 200 ? 2_097_152 : 65_536,
      signal,
    );
    if (bytes === 'body_too_large')
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'body_too_large' });
    if (bytes === 'response') {
      if (outerSignal?.aborted) return local({ code: 'CANCELLED', retryable: false });
      if (timeoutSignal.aborted)
        return local({ code: 'TIMEOUT', retryable: true, timeoutMs: this.options.timeoutMs });
      return local({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'response' });
    }
    if (response.headers.get('x-request-id') !== requestId) {
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'correlation' });
    }
    const parsed = BoardSdkHttpClient.parseStrictJsonBytesV1(bytes);
    if (!parsed.ok)
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: parsed.reason });
    if (response.status === 200) {
      const value = parseConnection(parsed.value, requestId, boardId);
      if (value === null)
        return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'schema' });
      this.options.logger.log({
        route: '/api/v1/mcp/connection',
        attempt: 1,
        durationMs: performance.now() - startedAt,
        requestId,
        resultCode: 'connected',
      });
      return { ok: true, value };
    }
    const body = exactRecord(parsed.value, ['error']);
    const error = body === null ? null : BoardErrorParserV1.parse(body.error);
    if (error === null || !error.ok || error.data.value.httpStatusHint !== response.status) {
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'status' });
    }
    this.options.logger.log({
      route: '/api/v1/mcp/connection',
      attempt: 1,
      durationMs: performance.now() - startedAt,
      requestId,
      resultCode: error.data.value.code,
    });
    return { ok: false, source: 'board', error: error.data.value };
  }
}
