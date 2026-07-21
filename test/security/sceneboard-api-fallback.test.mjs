import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SceneBoardApiError,
  acquirePairingLock,
  applyScenePatch,
  deleteCredentialIfGeneration,
  getOrCreateInstallationId,
  invokeProtected,
  parseApiInputBytes,
  parsePairingClaim,
  parsePairingRedeem,
  parsePairingStatus,
  requestJson,
  readCredential,
  resolveApiConfig,
  safeFailure,
  validatePairInput,
  writeCredential,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-core.mjs';

const TOKEN = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const TIME = '2026-07-17T12:00:00.000Z';
const CAPABILITIES = {
  protocolVersion: 1,
  type: 'board.capabilities',
  schemaVersion: '1.0.0',
  compatibilityMode: 'frozen-major',
  supported: {
    nodeTypes: [
      'layout.split',
      'layout.grid',
      'layout.tabs',
      'layout.canvas',
      'content.markdown',
      'content.code',
      'content.table',
      'content.chart',
      'content.map',
      'content.drawing',
      'content.status',
      'content.image',
      'content.progress',
      'content.hitl',
      'content.artifact',
    ],
    commandTypes: [
      'scene.replace',
      'scene.clear',
      'scene.restore',
      'hitl.request',
      'hitl.respond',
      'artifact.publish',
      'artifact.stop',
    ],
    operationTypes: [
      'board.list',
      'board.get',
      'board.create',
      'board.archive',
      'capabilities.get',
      'history.list',
      'history.get',
      'artifact.get',
      'hitl.read',
    ],
    eventTypes: [
      'board.snapshot',
      'board.revision.created',
      'hitl.updated',
      'artifact.status.changed',
      'presence.updated',
      'stream.resync.required',
      'stream.heartbeat',
      'stream.error',
    ],
    hitlKinds: ['info', 'choice', 'form', 'confirmation'],
    artifactRequestCapabilities: ['clipboard.write', 'download', 'fullscreen', 'network.fetch'],
  },
  limits: {
    maxEnvelopeBytes: 1_048_576,
    maxSceneBytes: 786_432,
    maxSceneDepth: 12,
    maxSceneNodes: 500,
    maxJsonDepth: 64,
    maxJsonContainerEntries: 10_000,
    maxSplitChildren: 12,
    maxGridColumns: 24,
    maxGridRows: 100,
    maxGridItems: 200,
    maxTabs: 20,
    maxCanvasItems: 200,
    maxCanvasExtent: 100_000,
    maxTitleChars: 200,
    maxImageAltChars: 500,
    maxMarkdownChars: 100_000,
    maxCodeChars: 200_000,
    maxTableColumns: 50,
    maxTableRows: 500,
    maxTableCells: 10_000,
    maxChartSeries: 32,
    maxChartPoints: 10_000,
    maxMapFeatures: 5_000,
    maxDrawingElements: 5_000,
    maxArtifactResources: 128,
    maxArtifactResourceBytes: 5_242_880,
    maxArtifactTotalBytes: 10_485_760,
    maxBoardArtifacts: 100,
    maxBoardArtifactVersions: 1_000,
    maxBoardArtifactResourceRows: 10_000,
    maxBoardArtifactChargedBytes: 536_870_912,
    maxHitlOptions: 50,
    maxHitlFields: 50,
    maxHitlTextChars: 60_000,
    maxHitlResponseBytes: 65_536,
    maxPageSize: 100,
    maxPageCursorChars: 512,
    maxHitlWaitMs: 30_000,
  },
  grantedCapabilities: ['board.read'],
  allowedArtifactRequestCapabilities: [],
};

const boardSummary = (revisionId = 'revision_2', revisionNumber = 2) => ({
  boardId: 'board_1',
  title: 'QA',
  createdAt: TIME,
  updatedAt: TIME,
  archivedAt: null,
  headRevision: { revisionId, revisionNumber, createdAt: TIME },
});

const boardSnapshot = (revisionId = 'revision_2', revisionNumber = 2) => ({
  protocolVersion: 1,
  type: 'board.snapshot',
  boardId: 'board_1',
  revision: {
    revisionId,
    revisionNumber,
    createdAt: TIME,
    previousRevisionId: revisionNumber === 1 ? null : 'revision_1',
    originType: revisionNumber === 1 ? 'board.create' : 'scene.replace',
    sourceRevisionId: null,
    actor: { principalKind: 'mcp_client', principalId: 'client_1' },
  },
  scene: { protocolVersion: 1, type: 'scene', root: null },
  hitl: [],
  artifacts: [],
  capabilities: CAPABILITIES,
  lastEventSequence: 1,
});

const openHitl = () => ({
  hitlRequestId: 'hitl_1',
  definition: {
    kind: 'info',
    title: 'Continue?',
    body: 'Review the result.',
    acknowledgeLabel: 'OK',
  },
  state: 'open',
  createdAt: TIME,
  expiresAt: '2026-07-17T12:10:00.000Z',
  stateUpdatedAt: TIME,
  response: null,
  answeredAt: null,
});

const response = (value, { requestId = null, status = 200, connection = false } = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId === null ? {} : { 'x-request-id': requestId }),
      ...(connection
        ? {
            'cache-control': 'no-store, private',
            pragma: 'no-cache',
            vary: 'Origin, Cookie, Authorization',
          }
        : {}),
    },
  });

const operationEnvelope = (
  requestId,
  type,
  data,
  { replayed = false, mutationBoardId = null } = {},
) => ({
  protocolVersion: 1,
  type: 'board.http.success',
  requestId,
  result:
    mutationBoardId === null
      ? {
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId,
          replayed,
          result: { type, ...data },
        }
      : {
          protocolVersion: 1,
          type: 'mutation.result',
          requestId,
          boardId: mutationBoardId,
          replayed,
          eventIds: [],
          result: { type, ...data },
        },
  metadata: { history: null },
});

const connection = (
  selectedBoard = null,
  scopes = ['board.read', 'board.write'],
  lifecyclePermissions = [],
  boardIds = ['board_1'],
) => ({
  principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
  grant: {
    grantId: 'grant_1',
    client: {
      clientId: 'client_1',
      clientName: 'SceneBoard QA',
      installationFingerprint: 'abcdefghijklmnop',
    },
    scopes,
    lifecyclePermissions,
    boardIds,
    lifetime: 'persistent',
    status: 'active',
    activatedAt: TIME,
    expiresAt: '2026-08-17T12:00:00.000Z',
  },
  selectedBoard,
  versions: { mcpServer: '1.4.2', boardProtocol: '1.0.0', api: 'v1' },
});

const configured = async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    SCENEBOARD_PROFILE: `${prefix}profile`,
  };
  const config = await resolveApiConfig({ cwd: root, env });
  await writeCredential(config, TOKEN);
  return { root, env };
};

test('pair input uses the server grant scope catalog order', () => {
  const input = {
    code: 'SB-ABCDEF-GHJKMN',
    clientName: 'SceneBoard QA',
    requestedScopes: [
      'board.read',
      'board.write',
      'board.history.read',
      'board.hitl.request',
      'board.hitl.respond',
      'artifact.publish',
      'artifact.control',
    ],
    requestedLifecyclePermissions: ['board.create', 'board.archive'],
  };
  assert.deepEqual(validatePairInput(input), input);
  assert.throws(
    () =>
      validatePairInput({
        ...input,
        requestedScopes: [...input.requestedScopes].sort(),
      }),
    { code: 'INVALID_PAYLOAD' },
  );
});

test('fallback config requires a complete selected project tuple and reports timeout-only environment selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-config-'));
  const environment = await resolveApiConfig({
    cwd: root,
    env: { ...process.env, XDG_STATE_HOME: join(root, 'state'), SCENEBOARD_TIMEOUT_MS: '45000' },
  });
  assert.equal(environment.source, 'environment');
  assert.equal(environment.timeoutMs, 45_000);
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { sceneboard: { env: { BOARD_API_URL: 'https://sceneboard.dev' } } },
    }),
  );
  await assert.rejects(resolveApiConfig({ cwd: root, env: process.env }), {
    code: 'BOARD_API_CONFIG_INVALID',
  });
});

test('Windows fallback stores only current-user protected credentials under LOCALAPPDATA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-windows-fallback-'));
  const localAppData = join(root, 'local-app-data');
  const windowsDataProtection = {
    protect: async (value) => Buffer.from(`current-user:${value}`, 'utf8').toString('base64'),
    unprotect: async (value) =>
      Buffer.from(value, 'base64').toString('utf8').replace('current-user:', ''),
  };
  const config = await resolveApiConfig({
    cwd: root,
    env: { ...process.env, LOCALAPPDATA: localAppData, SCENEBOARD_PROFILE: 'windows_pair' },
    platform: 'win32',
    windowsDataProtection,
  });
  assert.equal(
    config.stateDirectory,
    join(localAppData, 'leecat-board', 'credentials', 'windows_pair'),
  );
  const release = await acquirePairingLock(config);
  await release();
  const installationId = await getOrCreateInstallationId(config);
  assert.match(installationId, /^install_[A-Za-z0-9_-]{32}$/u);
  const generation = await writeCredential(config, TOKEN);
  const credentialPath = join(config.stateDirectory, 'credential.json');
  const source = await readFile(credentialPath, 'utf8');
  const stored = JSON.parse(source);
  assert.equal(source.includes(TOKEN), false);
  assert.deepEqual(Object.keys(stored), [
    'version',
    'generation',
    'protection',
    'protectedAccessToken',
  ]);
  assert.equal(stored.version, 2);
  assert.equal(stored.generation, generation);
  assert.equal(stored.protection, 'windows-dpapi-current-user');
  assert.equal((await readCredential(config)).accessToken, TOKEN);
  assert.equal(await deleteCredentialIfGeneration(config, 'z'.repeat(22)), false);
  const replacement = `lcbg_v1.${'c'.repeat(22)}.${'d'.repeat(43)}`;
  const replacementGeneration = await writeCredential(config, replacement);
  assert.equal((await readCredential(config)).accessToken, replacement);
  assert.equal(await deleteCredentialIfGeneration(config, replacementGeneration), true);
  assert.equal(await readCredential(config), null);
});

test('Windows fallback reports a closed credential error when current-user protection is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-windows-dpapi-failure-'));
  const config = await resolveApiConfig({
    cwd: root,
    env: {
      ...process.env,
      LOCALAPPDATA: join(root, 'local-app-data'),
      SCENEBOARD_PROFILE: 'windows_failure',
    },
    platform: 'win32',
    windowsDataProtection: {
      protect: async () => {
        throw new Error(`must-not-leak-${TOKEN}`);
      },
      unprotect: async () => {
        throw new Error(`must-not-leak-${TOKEN}`);
      },
    },
  });
  await assert.rejects(writeCredential(config, TOKEN), (error) => {
    const failure = safeFailure(error, 'pair');
    assert.equal(failure.error.code, 'BOARD_API_CREDENTIAL_UNAVAILABLE');
    assert.equal(JSON.stringify(failure).includes(TOKEN), false);
    return true;
  });
});

test('board-scoped connection accepts the closed capabilities contract and rejects missing cache headers', async () => {
  const { root, env } = await configured('connection-');
  const selectedBoard = {
    board: {
      boardId: 'board_1',
      title: 'QA',
      createdAt: TIME,
      updatedAt: TIME,
      archivedAt: null,
      headRevision: { revisionId: 'revision_1', revisionNumber: 1, createdAt: TIME },
    },
    capabilities: CAPABILITIES,
    browserPresence: 'online',
  };
  const fetchImpl = async (url, options) =>
    response(connection(selectedBoard), {
      requestId: options.headers['X-Request-Id'],
      connection: true,
    });
  const result = await invokeProtected(
    'board_connection_status',
    { boardId: 'board_1' },
    { cwd: root, env, fetchImpl },
  );
  assert.equal(result.result.connection.selectedBoard.capabilities.limits.maxCodeChars, 200_000);
  assert.equal(result.result.connection.versions.mcpServer, '1.4.2');
  const prerelease = connection(selectedBoard);
  prerelease.versions.mcpServer = '2.0.0-beta.1+build.7';
  assert.equal(
    (
      await invokeProtected(
        'board_connection_status',
        { boardId: 'board_1' },
        {
          cwd: root,
          env,
          fetchImpl: async (url, options) =>
            response(prerelease, {
              requestId: options.headers['X-Request-Id'],
              connection: true,
            }),
        },
      )
    ).result.connection.versions.mcpServer,
    '2.0.0-beta.1+build.7',
  );
  const malformedVersion = connection(selectedBoard);
  malformedVersion.versions.mcpServer = '01.2.3';
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(malformedVersion, {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(connection(selectedBoard), { requestId: options.headers['X-Request-Id'] }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const incomplete = structuredClone(selectedBoard);
  delete incomplete.capabilities.limits.maxCodeChars;
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(connection(incomplete), {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const extra = structuredClone(selectedBoard);
  extra.capabilities.supported.debug = TOKEN;
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(connection(extra), {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const secretClient = connection(selectedBoard);
  secretClient.grant.client.clientName = TOKEN;
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(secretClient, {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const secretTitle = structuredClone(selectedBoard);
  secretTitle.board.title = TOKEN;
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(connection(secretTitle), {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const controlClient = connection(selectedBoard);
  controlClient.grant.client.clientName = 'SceneBoard\nQA';
  await assert.rejects(
    invokeProtected(
      'board_connection_status',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) =>
          response(controlClient, {
            requestId: options.headers['X-Request-Id'],
            connection: true,
          }),
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
});

test('untargeted connection accepts a create-capable grant before its first board exists', async () => {
  const { root, env } = await configured('connection-empty-');
  const result = await invokeProtected(
    'board_connection_status',
    { boardId: null },
    {
      cwd: root,
      env,
      fetchImpl: async (url, options) =>
        response(connection(null, ['board.write'], ['board.create'], []), {
          requestId: options.headers['X-Request-Id'],
          connection: true,
        }),
    },
  );
  assert.deepEqual(result.result.connection.grant.boardIds, []);
  assert.equal(result.result.connection.selectedBoard, null);
});

test('connection and error projections reject non-string global and local identifiers', async () => {
  const { root, env } = await configured('typed-identifiers-');
  for (const invalidId of [null, 7, [], {}]) {
    const invalidConnection = connection();
    invalidConnection.principal.principalId = invalidId;
    invalidConnection.grant.client.clientId = invalidId;
    await assert.rejects(
      invokeProtected(
        'board_connection_status',
        { boardId: null },
        {
          cwd: root,
          env,
          fetchImpl: async (url, options) =>
            response(invalidConnection, {
              requestId: options.headers['X-Request-Id'],
              connection: true,
            }),
        },
      ),
      { code: 'BOARD_API_RESPONSE_INVALID' },
    );
    const requestId = 'request_1234567890';
    await assert.rejects(
      requestJson({
        config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
        path: '/board',
        requestId,
        expectedStatus: [200],
        allowedErrorCodes: ['DUPLICATE_NODE_ID'],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                protocolVersion: 1,
                type: 'board.error',
                code: 'DUPLICATE_NODE_ID',
                message: 'Duplicate',
                category: 'validation',
                retryable: false,
                httpStatusHint: 422,
                details: { nodeId: invalidId, firstPath: ['root'], duplicatePath: ['root', 1] },
              },
            }),
            {
              status: 422,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'x-request-id': requestId,
              },
            },
          ),
      }),
      { code: 'BOARD_API_RESPONSE_INVALID' },
    );
  }
});

test('scene patch reports revision conflict before applying operations', async () => {
  const { root, env } = await configured('patch-');
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests += 1;
    const requestId = options.headers['X-Request-Id'];
    return response(
      operationEnvelope(requestId, 'board.get', {
        board: boardSummary(),
        snapshot: boardSnapshot(),
      }),
      { requestId },
    );
  };
  await assert.rejects(
    invokeProtected(
      'board_scene_patch',
      {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'qa-key-1234567890',
        operations: [{ type: 'replace_root', root: null }],
      },
      { cwd: root, env, fetchImpl },
    ),
    (error) => {
      assert.equal(error.code, 'REVISION_CONFLICT');
      assert.deepEqual(error.details, {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        actualRevisionId: 'revision_2',
        actualRevisionNumber: 2,
        recovery: 'fetch_latest_then_retry',
      });
      return true;
    },
  );
  assert.equal(requests, 1);
});

test('scene patch uses distinct HTTP correlation IDs for its head read and mutation', async () => {
  const { root, env } = await configured('patch-correlation-');
  const requestIds = [];
  const result = await invokeProtected(
    'board_scene_patch',
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_2',
      idempotencyKey: 'qa-key-correlation-1234',
      operations: [{ type: 'replace_root', root: null }],
    },
    {
      cwd: root,
      env,
      fetchImpl: async (url, options) => {
        const requestId = options.headers['X-Request-Id'];
        requestIds.push(requestId);
        if (requestIds.length === 1) {
          return response(
            operationEnvelope(requestId, 'board.get', {
              board: boardSummary(),
              snapshot: boardSnapshot(),
            }),
            { requestId },
          );
        }
        return response(
          operationEnvelope(
            requestId,
            'scene.replace',
            {
              revision: boardSummary('revision_3', 3).headRevision,
            },
            { mutationBoardId: 'board_1' },
          ),
          { requestId },
        );
      },
    },
  );
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
  assert.equal(result.requestId, requestIds[1]);
  assert.equal(result.result.result.type, 'scene.replace');
});

test('protected results enforce request, status, and board correlation', async () => {
  const { root, env } = await configured('result-');
  const board = await invokeProtected(
    'board_get',
    { boardId: 'board_1' },
    {
      cwd: root,
      env,
      fetchImpl: async (url, options) => {
        const requestId = options.headers['X-Request-Id'];
        return response(
          operationEnvelope(requestId, 'board.get', {
            board: boardSummary(),
            snapshot: boardSnapshot(),
          }),
          { requestId },
        );
      },
    },
  );
  assert.equal(board.result.result.board.boardId, 'board_1');
  const shortTextBoard = boardSummary();
  shortTextBoard.title = 'Line one\nLine two';
  const shortTextResult = await invokeProtected(
    'board_get',
    { boardId: 'board_1' },
    {
      cwd: root,
      env,
      fetchImpl: async (url, options) => {
        const requestId = options.headers['X-Request-Id'];
        return response(
          operationEnvelope(requestId, 'board.get', {
            board: shortTextBoard,
            snapshot: boardSnapshot(),
          }),
          { requestId },
        );
      },
    },
  );
  assert.equal(shortTextResult.result.result.board.title, 'Line one\nLine two');
  await assert.rejects(
    invokeProtected(
      'board_create',
      { title: 'QA', idempotencyKey: 'qa-key-1234567890' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'board.create', { board: { boardId: 'board_1' } }),
            { requestId, status: 201 },
          );
        },
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  await assert.rejects(
    invokeProtected(
      'board_scene_clear',
      {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'qa-key-1234567890',
      },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'scene.clear', {}, { mutationBoardId: 'board_2' }),
            { requestId },
          );
        },
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const crossBoard = boardSnapshot();
  crossBoard.boardId = 'board_2';
  await assert.rejects(
    invokeProtected(
      'board_get',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'board.get', {
              board: boardSummary(),
              snapshot: crossBoard,
            }),
            { requestId },
          );
        },
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const secretBearing = boardSnapshot();
  secretBearing.scene.root = {
    id: 'note',
    type: 'content.markdown',
    markdown: `prefix ${TOKEN} suffix`,
  };
  await assert.rejects(
    invokeProtected(
      'board_get',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'board.get', {
              board: boardSummary(),
              snapshot: secretBearing,
            }),
            { requestId },
          );
        },
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
});

test('HITL projections are exact, correlated, chronological, and context-secret-free', async () => {
  const { root, env } = await configured('hitl-projection-');
  const invoke = (hitl) =>
    invokeProtected(
      'board_get',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const snapshot = boardSnapshot();
          snapshot.hitl = [hitl];
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'board.get', { board: boardSummary(), snapshot }),
            { requestId },
          );
        },
      },
    );
  assert.equal((await invoke(openHitl())).result.result.snapshot.hitl[0].definition.kind, 'info');

  const extra = openHitl();
  extra.definition.surprise = true;
  extra.definition.proof = 'p'.repeat(43);
  await assert.rejects(invoke(extra), { code: 'BOARD_API_RESPONSE_INVALID' });

  const invalidChronology = openHitl();
  invalidChronology.stateUpdatedAt = '2026-07-17T12:00:01.000Z';
  await assert.rejects(invoke(invalidChronology), { code: 'BOARD_API_RESPONSE_INVALID' });

  const unknownChoice = openHitl();
  unknownChoice.definition = {
    kind: 'choice',
    title: 'Choose',
    multiple: false,
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: 'known', label: 'Known' }],
  };
  unknownChoice.state = 'answered';
  unknownChoice.response = { kind: 'choice', selectedOptionIds: ['unknown'] };
  unknownChoice.answeredAt = '2026-07-17T12:00:01.000Z';
  unknownChoice.stateUpdatedAt = unknownChoice.answeredAt;
  await assert.rejects(invoke(unknownChoice), { code: 'BOARD_API_RESPONSE_INVALID' });

  const contextualSecret = openHitl();
  contextualSecret.definition = {
    kind: 'form',
    title: 'Form',
    submitLabel: 'Submit',
    fields: [
      {
        id: 'proof',
        type: 'text',
        label: 'Value',
        required: true,
        defaultValue: null,
        minLength: 1,
        maxLength: 100,
      },
    ],
  };
  contextualSecret.state = 'answered';
  contextualSecret.response = { kind: 'form', values: { proof: 'p'.repeat(43) } };
  contextualSecret.answeredAt = '2026-07-17T12:00:01.000Z';
  contextualSecret.stateUpdatedAt = contextualSecret.answeredAt;
  await assert.rejects(invoke(contextualSecret), { code: 'BOARD_API_RESPONSE_INVALID' });

  const proofDefault = structuredClone(contextualSecret);
  proofDefault.state = 'open';
  proofDefault.response = null;
  proofDefault.answeredAt = null;
  proofDefault.stateUpdatedAt = proofDefault.createdAt;
  proofDefault.definition.fields[0].defaultValue = 'p'.repeat(43);
  await assert.rejects(invoke(proofDefault), { code: 'BOARD_API_RESPONSE_INVALID' });

  const generationDefault = structuredClone(proofDefault);
  generationDefault.definition.fields[0].id = 'generation';
  generationDefault.definition.fields[0].defaultValue = 'g'.repeat(22);
  await assert.rejects(invoke(generationDefault), { code: 'BOARD_API_RESPONSE_INVALID' });

  const sensitiveOption = openHitl();
  sensitiveOption.definition = {
    kind: 'choice',
    title: 'Choose',
    multiple: false,
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: 'proof', label: 'p'.repeat(43) }],
  };
  await assert.rejects(invoke(sensitiveOption), { code: 'BOARD_API_RESPONSE_INVALID' });

  const sensitiveSelect = structuredClone(proofDefault);
  sensitiveSelect.definition.fields[0] = {
    id: 'token',
    type: 'select',
    label: 'Token',
    required: false,
    defaultValue: 'g'.repeat(22),
    options: [{ id: 'g'.repeat(22), label: 'Ordinary option' }],
  };
  await assert.rejects(invoke(sensitiveSelect), { code: 'BOARD_API_RESPONSE_INVALID' });

  const ordinaryPasswordField = structuredClone(contextualSecret);
  ordinaryPasswordField.response.values.password = 'ordinary answer';
  ordinaryPasswordField.definition.fields[0].id = 'password';
  ordinaryPasswordField.definition.fields[0].defaultValue = 'ordinary answer';
  delete ordinaryPasswordField.response.values.proof;
  assert.equal(
    (await invoke(ordinaryPasswordField)).result.result.snapshot.hitl[0].response.values.password,
    'ordinary answer',
  );

  const tableSnapshot = boardSnapshot();
  tableSnapshot.scene.root = {
    id: 'table',
    type: 'content.table',
    columns: [{ key: 'token', label: 'Design token', valueType: 'string' }],
    rows: [{ id: 'row', cells: { token: 'primary-color' } }],
  };
  const table = await invokeProtected(
    'board_get',
    { boardId: 'board_1' },
    {
      cwd: root,
      env,
      fetchImpl: async (url, options) => {
        const requestId = options.headers['X-Request-Id'];
        return response(
          operationEnvelope(requestId, 'board.get', {
            board: boardSummary(),
            snapshot: tableSnapshot,
          }),
          { requestId },
        );
      },
    },
  );
  assert.equal(table.result.result.snapshot.scene.root.rows[0].cells.token, 'primary-color');

  const nestedScene = boardSnapshot();
  nestedScene.scene.root = {
    id: 'map',
    type: 'content.map',
    viewport: { longitude: 0, latitude: 0, zoom: 1 },
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            password: { value: 'ordinary answer' },
            token: [{ value: 'primary-color' }],
          },
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    },
  };
  const invokeScene = () =>
    invokeProtected(
      'board_get',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          const requestId = options.headers['X-Request-Id'];
          return response(
            operationEnvelope(requestId, 'board.get', {
              board: boardSummary(),
              snapshot: nestedScene,
            }),
            { requestId },
          );
        },
      },
    );
  assert.equal(
    (await invokeScene()).result.result.snapshot.scene.root.data.features[0].properties.password
      .value,
    'ordinary answer',
  );

  nestedScene.scene.root.data.features[0].properties.proof = { value: 'p'.repeat(43) };
  await assert.rejects(invokeScene(), { code: 'BOARD_API_RESPONSE_INVALID' });
  delete nestedScene.scene.root.data.features[0].properties.proof;
  nestedScene.scene.root.data.features[0].properties.generation = [{ value: 'g'.repeat(22) }];
  await assert.rejects(invokeScene(), { code: 'BOARD_API_RESPONSE_INVALID' });
});

test('pairing parsers enforce exact finite-state and grant contracts', () => {
  const claim = parsePairingClaim({
    pairingId: 'pairing_1',
    state: 'pending',
    decisionExpiresAt: TIME,
    pollAfterSeconds: 2,
  });
  assert.equal(
    parsePairingStatus(
      {
        pairingId: claim.pairingId,
        state: 'pending',
        retryAfterSeconds: 5,
        decisionExpiresAt: TIME,
        redeemExpiresAt: null,
      },
      claim.pairingId,
    ).retryAfterSeconds,
    5,
  );
  assert.throws(
    () =>
      parsePairingStatus(
        {
          pairingId: claim.pairingId,
          state: 'pending',
          retryAfterSeconds: 0,
          decisionExpiresAt: TIME,
          redeemExpiresAt: null,
        },
        claim.pairingId,
      ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const redeemed = parsePairingRedeem({
    tokenType: 'Bearer',
    accessToken: TOKEN,
    grant: {
      grantId: 'grant_1',
      client: {
        clientId: 'client_1',
        clientName: 'SceneBoard QA',
        installationFingerprint: 'abcdefghijklmnop',
      },
      scopes: ['board.read'],
      lifecyclePermissions: [],
      boardIds: ['board_1'],
      lifetime: 'persistent',
      status: 'active',
      createdAt: TIME,
      activatedAt: TIME,
      lastUsedAt: null,
      expiresAt: '2026-08-17T12:00:00.000Z',
      revokedAt: null,
    },
  });
  assert.equal(redeemed.grant.status, 'active');
  const empty = parsePairingRedeem({
    ...redeemed,
    grant: {
      ...redeemed.grant,
      scopes: ['board.write'],
      lifecyclePermissions: ['board.create'],
      boardIds: [],
    },
  });
  assert.deepEqual(empty.grant.boardIds, []);
  for (const mutate of [
    (value) => {
      value.accessToken = 'not-a-token';
    },
    (value) => {
      value.grant.extra = true;
    },
    (value) => {
      value.grant.revokedAt = TIME;
    },
    (value) => {
      value.grant.scopes = [];
    },
    (value) => {
      value.grant.client.clientName = TOKEN;
    },
  ]) {
    const malformed = structuredClone(redeemed);
    malformed.accessToken = TOKEN;
    mutate(malformed);
    assert.throws(() => parsePairingRedeem(malformed), { code: 'BOARD_API_RESPONSE_INVALID' });
  }
});

test('strict stdin and failure projection reject duplicate JSON and redact secrets', () => {
  assert.throws(() => parseApiInputBytes(Buffer.from('{"boardId":"a","boardId":"b"}')), {
    code: 'INVALID_PAYLOAD',
  });
  const failure = safeFailure(
    new SceneBoardApiError('INTERNAL_ERROR', 'synthetic', {
      details: {
        authorization: `Bearer ${TOKEN}`,
        path: '/workspace/private/example',
        alternatePath: '/opt/private/example',
      },
    }),
    'board_list',
  );
  assert.equal(failure.error.details.authorization, '[redacted]');
  assert.equal(failure.error.details.path, '[redacted]');
  assert.equal(failure.error.details.alternatePath, '[redacted]');
  assert.equal(JSON.stringify(failure).includes(TOKEN), false);
});

test('board errors are operation-allowlisted, exactly projected, and secret-free', async () => {
  const requestId = 'request_1234567890';
  const invalid = (error) =>
    new Response(JSON.stringify({ error }), {
      status: error.httpStatusHint,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
    });
  const capabilityDenied = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'CAPABILITY_DENIED',
    message: 'Denied',
    category: 'auth',
    retryable: false,
    httpStatusHint: 403,
    details: { capability: 'artifact.publish' },
  };
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/board',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['INVALID_PAYLOAD', 'BOARD_NOT_FOUND'],
      fetchImpl: async () => invalid(capabilityDenied),
    }),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const malformed = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'INVALID_PAYLOAD',
    message: 'Invalid',
    category: 'not-validation',
    retryable: false,
    httpStatusHint: 400,
    details: { path: '/private/example', issue: `prefix ${TOKEN} suffix` },
  };
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/board',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['INVALID_PAYLOAD'],
      fetchImpl: async () => invalid(malformed),
    }),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const secretPath = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'INVALID_PAYLOAD',
    message: 'Invalid',
    category: 'validation',
    retryable: false,
    httpStatusHint: 400,
    details: { path: [TOKEN], issue: 'invalid field' },
  };
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/board',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['INVALID_PAYLOAD'],
      fetchImpl: async () => invalid(secretPath),
    }),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  const longUnknown = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'UNKNOWN_NODE_TYPE',
    message: 'Unknown node type',
    category: 'validation',
    retryable: false,
    httpStatusHint: 422,
    details: {
      path: Array.from({ length: 65 }, (_, index) => index),
      receivedType: 'x'.repeat(201),
    },
  };
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/board',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['UNKNOWN_NODE_TYPE'],
      fetchImpl: async () => invalid(longUnknown),
    }),
    { code: 'UNKNOWN_NODE_TYPE' },
  );
  const largeProtocolMajor = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'PROTOCOL_VERSION_MISMATCH',
    message: 'Protocol mismatch',
    category: 'protocol',
    retryable: false,
    httpStatusHint: 409,
    details: {
      reason: 'major',
      supportedMajor: 1,
      receivedMajor: 9_007_199_254_740_992,
      field: 'protocolVersion',
    },
  };
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/board',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['PROTOCOL_VERSION_MISMATCH'],
      fetchImpl: async () => invalid(largeProtocolMajor),
    }),
    { code: 'PROTOCOL_VERSION_MISMATCH' },
  );
  const { root, env } = await configured('operation-errors-');
  const errorResponse = async (url, options) =>
    new Response(JSON.stringify({ error: capabilityDenied }), {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-request-id': options.headers['X-Request-Id'],
      },
    });
  await assert.rejects(
    invokeProtected(
      'board_get',
      { boardId: 'board_1' },
      {
        cwd: root,
        env,
        fetchImpl: errorResponse,
      },
    ),
    { code: 'BOARD_API_RESPONSE_INVALID' },
  );
  await assert.rejects(
    invokeProtected(
      'board_artifact_put',
      {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'qa-key-1234567890',
        artifactId: null,
        html: '<main>QA</main>',
        css: null,
        javascript: null,
        requestedCapabilities: [],
      },
      { cwd: root, env, fetchImpl: errorResponse },
    ),
    { code: 'CAPABILITY_DENIED' },
  );
});

test('credential invalidation lock contention preserves the auth result and truthful token presence', async () => {
  const { root, env } = await configured('invalidation-lock-');
  const config = await resolveApiConfig({ cwd: root, env });
  const lockPath = join(config.stateDirectory, 'api-credential.lock');
  await writeFile(lockPath, JSON.stringify({ version: 1, nonce: 'held-for-test' }));
  await chmod(lockPath, 0o600);
  const unauthenticated = async (url, options) =>
    new Response(
      JSON.stringify({
        error: {
          protocolVersion: 1,
          type: 'board.error',
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated',
          category: 'auth',
          retryable: false,
          httpStatusHint: 401,
          details: null,
        },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-request-id': options.headers['X-Request-Id'],
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          vary: 'Origin, Cookie, Authorization',
        },
      },
    );
  await assert.rejects(
    invokeProtected(
      'board_list',
      { cursor: null, limit: 10, includeArchived: false },
      {
        cwd: root,
        env,
        fetchImpl: unauthenticated,
      },
    ),
    { code: 'UNAUTHENTICATED' },
  );
  const status = await invokeProtected(
    'board_connection_status',
    { boardId: null },
    {
      cwd: root,
      env,
      fetchImpl: unauthenticated,
    },
  );
  assert.equal(status.result.state, 'credential_invalid');
  assert.equal(status.result.config.hasToken, true);
  assert.equal((await readCredential(config)).accessToken, TOKEN);
  await unlink(lockPath);
});

test('read retries share one total timeout instead of resetting per attempt', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/never',
      expectedStatus: [200],
      retryKind: 'read',
      fetchImpl: async (url, options) =>
        new Promise((resolve, reject) => {
          const keeper = setTimeout(() => reject(new Error('timeout signal did not abort')), 2_000);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(keeper);
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    }),
    { code: 'BOARD_API_TIMEOUT' },
  );
  assert.ok(Date.now() - startedAt < 1_800);
});

test('retry delay that exceeds the remaining deadline is reported as timeout', async () => {
  const requestId = 'request_1234567890';
  const startedAt = Date.now();
  await assert.rejects(
    requestJson({
      config: { baseUrl: 'http://127.0.0.1:3411', timeoutMs: 1_000 },
      path: '/busy',
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: ['SERVICE_UNAVAILABLE'],
      retryKind: 'read',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              protocolVersion: 1,
              type: 'board.error',
              code: 'SERVICE_UNAVAILABLE',
              message: 'Busy',
              category: 'availability',
              retryable: true,
              httpStatusHint: 503,
              details: { retryAfterSeconds: 2 },
            },
          }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'x-request-id': requestId,
              'retry-after': '2',
            },
          },
        ),
    }),
    { code: 'BOARD_API_TIMEOUT' },
  );
  assert.ok(Date.now() - startedAt < 500);
});

test('scene patch shares one monotonic timeout across head fetch and mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-patch-budget-'));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    SCENEBOARD_PROFILE: 'patch_budget',
    SCENEBOARD_TIMEOUT_MS: '1000',
  };
  const config = await resolveApiConfig({ cwd: root, env });
  await writeCredential(config, TOKEN);
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(
    invokeProtected(
      'board_scene_patch',
      {
        boardId: 'board_1',
        expectedRevisionId: 'revision_2',
        idempotencyKey: 'qa-key-1234567890',
        operations: [{ type: 'replace_root', root: null }],
      },
      {
        cwd: root,
        env,
        fetchImpl: async (url, options) => {
          calls += 1;
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 650));
            const requestId = options.headers['X-Request-Id'];
            return response(
              operationEnvelope(requestId, 'board.get', {
                board: boardSummary(),
                snapshot: boardSnapshot(),
              }),
              { requestId },
            );
          }
          return new Promise((resolve, reject) => {
            const keeper = setTimeout(
              () => reject(new Error('operation deadline did not abort')),
              2_000,
            );
            if (options.signal.aborted) {
              clearTimeout(keeper);
              reject(options.signal.reason);
            } else
              options.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(keeper);
                  reject(options.signal.reason);
                },
                { once: true },
              );
          });
        },
      },
    ),
    { code: 'BOARD_API_TIMEOUT' },
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt < 1_350);
});

test('credential state repairs directory mode and serializes generation invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-credential-'));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    SCENEBOARD_PROFILE: 'credential_race',
  };
  const config = await resolveApiConfig({ cwd: root, env });
  const firstGeneration = await writeCredential(config, TOKEN);
  await chmod(config.stateDirectory, 0o770);
  assert.equal((await readCredential(config)).accessToken, TOKEN);
  assert.equal((await stat(config.stateDirectory)).mode & 0o777, 0o700);
  assert.equal(await deleteCredentialIfGeneration(config, 'z'.repeat(22)), false);
  assert.equal((await readCredential(config)).generation, firstGeneration);
  const replacement = `lcbg_v1.${'c'.repeat(22)}.${'d'.repeat(43)}`;
  await Promise.all([
    deleteCredentialIfGeneration(config, firstGeneration),
    writeCredential(config, replacement),
  ]);
  const current = await readCredential(config);
  assert.equal(current.accessToken, replacement);
  assert.equal(await deleteCredentialIfGeneration(config, current.generation), true);
  assert.equal(await readCredential(config), null);
});

test('patch geometry validates every supplied numeric field', () => {
  const scene = {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'grid',
      type: 'layout.grid',
      columns: 2,
      rows: 2,
      children: [
        {
          node: { id: 'child', type: 'content.status', tone: 'info', text: 'QA' },
          column: 1,
          row: 1,
          columnSpan: 1,
          rowSpan: 1,
        },
      ],
    },
  };
  assert.throws(
    () =>
      applyScenePatch(scene, [
        {
          type: 'set_grid_placement',
          gridNodeId: 'grid',
          childNodeId: 'child',
          column: 1,
          row: '2',
          columnSpan: 1,
          rowSpan: 1,
        },
      ]),
    { code: 'INVALID_PAYLOAD' },
  );
});

test('one-process pairing keeps proof private and proves the stored credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-pair-'));
  const stateRoot = join(root, 'state');
  const pairingCode = 'SB-ABCDEF-GHJKMN';
  let challenge = null;
  let proof = null;
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks));
    const send = (statusCode, value, kind) => {
      reply.statusCode = statusCode;
      reply.setHeader('content-type', 'application/json; charset=utf-8');
      reply.setHeader('cache-control', 'no-store, private');
      reply.setHeader('pragma', 'no-cache');
      if (kind === 'connection') reply.setHeader('vary', 'Origin, Cookie, Authorization');
      else if (kind !== 'claim') reply.setHeader('vary', 'Authorization');
      if (request.headers['x-request-id'] !== undefined)
        reply.setHeader('x-request-id', request.headers['x-request-id']);
      reply.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/v1/pairings/claim') {
      assert.equal(body.code, pairingCode);
      challenge = body.clientProofChallenge;
      send(
        202,
        {
          pairingId: 'pairing_1',
          state: 'pending',
          decisionExpiresAt: '2026-07-17T12:05:00.000Z',
          pollAfterSeconds: 2,
        },
        'claim',
      );
      return;
    }
    if (url.pathname.endsWith('/client-status')) {
      proof = String(request.headers.authorization).replace('PairingProof ', '');
      send(
        200,
        {
          pairingId: 'pairing_1',
          state: 'approved',
          retryAfterSeconds: null,
          decisionExpiresAt: '2026-07-17T12:05:00.000Z',
          redeemExpiresAt: '2026-07-17T12:07:00.000Z',
        },
        'status',
      );
      return;
    }
    if (url.pathname.endsWith('/redeem')) {
      send(
        200,
        {
          tokenType: 'Bearer',
          accessToken: TOKEN,
          grant: {
            grantId: 'grant_1',
            client: {
              clientId: 'client_1',
              clientName: 'SceneBoard QA',
              installationFingerprint: 'abcdefghijklmnop',
            },
            scopes: ['board.read'],
            lifecyclePermissions: [],
            boardIds: ['board_1'],
            lifetime: 'persistent',
            status: 'active',
            createdAt: TIME,
            activatedAt: TIME,
            lastUsedAt: null,
            expiresAt: '2026-08-17T12:00:00.000Z',
            revokedAt: null,
          },
        },
        'redeem',
      );
      return;
    }
    if (url.pathname === '/api/v1/mcp/connection') {
      send(200, connection(null, ['board.read']), 'connection');
      return;
    }
    reply.statusCode = 404;
    reply.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(
    process.execPath,
    [
      join(
        process.cwd(),
        'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api.mjs',
      ),
      'pair',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
        SCENEBOARD_API_URL: `http://127.0.0.1:${address.port}`,
        SCENEBOARD_PROFILE: 'qa_pair',
        SCENEBOARD_TIMEOUT_MS: '5000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(
    JSON.stringify({
      code: pairingCode,
      clientName: 'SceneBoard QA',
      requestedScopes: ['board.read'],
      requestedLifecyclePermissions: [],
    }),
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => server.close(resolve));
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout).toString();
  assert.equal(output.includes(pairingCode), false);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes(proof), false);
  assert.equal(
    createHash('sha256').update(Buffer.from(proof, 'base64url')).digest('base64url'),
    challenge,
  );
  const credentialPath = join(
    stateRoot,
    'leecat-board',
    'credentials',
    'qa_pair',
    'credential.json',
  );
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(credentialPath, 'utf8')).accessToken, TOKEN);
  assert.deepEqual(
    output
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((event) => event.event),
    ['claimed', 'status', 'redeemed'],
  );
});

test('pairing rejects contradictory authorization before credential persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-pair-mismatch-'));
  const stateRoot = join(root, 'state');
  const decisionExpiresAt = new Date(Date.now() - 1_000).toISOString();
  const redeemExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    for await (const _chunk of request) {
      // Drain the request body before responding.
    }
    const send = (statusCode, value, kind) => {
      reply.statusCode = statusCode;
      reply.setHeader('content-type', 'application/json; charset=utf-8');
      reply.setHeader('cache-control', 'no-store, private');
      reply.setHeader('pragma', 'no-cache');
      if (kind === 'connection') reply.setHeader('vary', 'Origin, Cookie, Authorization');
      else if (kind !== 'claim') reply.setHeader('vary', 'Authorization');
      if (request.headers['x-request-id'] !== undefined)
        reply.setHeader('x-request-id', request.headers['x-request-id']);
      reply.end(JSON.stringify(value));
    };
    if (url.pathname.endsWith('/claim')) {
      send(
        202,
        { pairingId: 'pairing_mismatch', state: 'pending', decisionExpiresAt, pollAfterSeconds: 2 },
        'claim',
      );
    } else if (url.pathname.endsWith('/client-status')) {
      send(
        200,
        {
          pairingId: 'pairing_mismatch',
          state: 'approved',
          retryAfterSeconds: null,
          decisionExpiresAt,
          redeemExpiresAt,
        },
        'status',
      );
    } else if (url.pathname.endsWith('/redeem')) {
      send(
        200,
        {
          tokenType: 'Bearer',
          accessToken: TOKEN,
          grant: {
            grantId: 'grant_1',
            client: {
              clientId: 'client_1',
              clientName: 'SceneBoard QA',
              installationFingerprint: 'abcdefghijklmnop',
            },
            scopes: ['board.read'],
            lifecyclePermissions: [],
            boardIds: ['board_1'],
            lifetime: 'persistent',
            status: 'active',
            createdAt: TIME,
            activatedAt: TIME,
            lastUsedAt: null,
            expiresAt: '2026-08-17T12:00:00.000Z',
            revokedAt: null,
          },
        },
        'redeem',
      );
    } else if (url.pathname === '/api/v1/mcp/connection') {
      send(200, connection(), 'connection');
    } else {
      reply.statusCode = 404;
      reply.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(
    process.execPath,
    [
      join(
        process.cwd(),
        'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api.mjs',
      ),
      'pair',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
        SCENEBOARD_API_URL: `http://127.0.0.1:${address.port}`,
        SCENEBOARD_PROFILE: 'qa_pair_mismatch',
        SCENEBOARD_TIMEOUT_MS: '1000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(
    JSON.stringify({
      code: 'SB-ABCDEF-GHJKMN',
      clientName: 'SceneBoard QA',
      requestedScopes: ['board.read'],
      requestedLifecyclePermissions: [],
    }),
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => server.close(resolve));
  assert.equal(exitCode, 1, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout);
  assert.equal(output.includes(TOKEN), false);
  const failure = output.toString().trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(failure.error.code, 'BOARD_API_PAIRING_CREDENTIAL_UNRECOVERABLE');
  assert.equal(failure.error.details.phase, 'authorization_validation');
  assert.equal(failure.error.details.reason, undefined);
  assert.equal(failure.error.details.recovery, 'owner_rotate_or_revoke_and_repair');
  await assert.rejects(
    stat(join(stateRoot, 'leecat-board', 'credentials', 'qa_pair_mismatch', 'credential.json')),
    { code: 'ENOENT' },
  );
});

test('ambiguous redeem retry returns one owner-recovery failure and never redeems a third time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-pair-ambiguous-'));
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let statusCalls = 0;
  let redeemCalls = 0;
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    for await (const _chunk of request) {
      // Drain the request body before responding.
    }
    const send = (statusCode, value, kind) => {
      reply.statusCode = statusCode;
      reply.setHeader('content-type', 'application/json; charset=utf-8');
      reply.setHeader('cache-control', 'no-store, private');
      reply.setHeader('pragma', 'no-cache');
      if (kind !== 'claim') reply.setHeader('vary', 'Authorization');
      reply.end(JSON.stringify(value));
    };
    if (url.pathname.endsWith('/claim')) {
      send(
        202,
        {
          pairingId: 'pairing_ambiguous',
          state: 'pending',
          decisionExpiresAt: expiresAt,
          pollAfterSeconds: 2,
        },
        'claim',
      );
      return;
    }
    if (url.pathname.endsWith('/client-status')) {
      statusCalls += 1;
      send(
        200,
        {
          pairingId: 'pairing_ambiguous',
          state: 'approved',
          retryAfterSeconds: null,
          decisionExpiresAt: expiresAt,
          redeemExpiresAt: expiresAt,
        },
        'status',
      );
      return;
    }
    if (url.pathname.endsWith('/redeem')) {
      redeemCalls += 1;
      request.socket.destroy();
      return;
    }
    reply.statusCode = 404;
    reply.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(
    process.execPath,
    [
      join(
        process.cwd(),
        'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api.mjs',
      ),
      'pair',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(root, 'state'),
        SCENEBOARD_API_URL: `http://127.0.0.1:${address.port}`,
        SCENEBOARD_PROFILE: 'qa_pair_ambiguous',
        SCENEBOARD_TIMEOUT_MS: '1000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(
    JSON.stringify({
      code: 'SB-ABCDEF-GHJKMN',
      clientName: 'SceneBoard QA',
      requestedScopes: ['board.read'],
      requestedLifecyclePermissions: [],
    }),
  );
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => server.close(resolve));
  const events = Buffer.concat(stdout).toString().trim().split('\n').map(JSON.parse);
  const failure = events.at(-1);
  assert.equal(exitCode, 1);
  assert.equal(failure.error.code, 'BOARD_API_PAIRING_OUTCOME_UNKNOWN');
  assert.equal(failure.error.details.recovery, 'owner_rotate_or_revoke_and_repair');
  assert.equal(statusCalls, 2);
  assert.equal(redeemCalls, 2);
});
