import { register, tsImport } from 'tsx/esm/api';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const backendRegistration = register({
  namespace: 'security-authorization-owner',
  tsconfig: new URL('../../sceneboard-be/tsconfig.json', import.meta.url).pathname,
});
const backendImport = (specifier) => backendRegistration.import(specifier, import.meta.url);

const { authorizationRuleFor, isBoardAccessOperation, ACCOUNT_API_KEY_SNAPSHOT } =
  await backendImport('../../sceneboard-be/src/grants/board-access.policy.ts');
const { accountApiKeyRequiredScopes } = await backendImport(
  '../../sceneboard-be/src/api-keys/account-api-key-authorization.policy.ts',
);
const { ExportAuthorizationPolicyV1 } = await backendImport(
  '../../sceneboard-be/src/exports/export-authorization.policy.ts',
);
const { ExportAdmissionServiceV1 } = await backendImport(
  '../../sceneboard-be/src/exports/export-admission.service.ts',
);
const { MysqlBoardAccessPolicy } = await backendImport(
  '../../sceneboard-be/src/grants/board-access-policy.service.ts',
);
const { BoardMembershipAuthorizationService } = await backendImport(
  '../../sceneboard-be/src/memberships/membership.service.ts',
);
const { accountApiKeyScopeMask } = await backendImport(
  '../../sceneboard-be/src/api-keys/account-api-key.scope.ts',
);
const { D2_SCOPE_CATALOG, lifecycleMaskFromValues, scopeMaskFromValues } = await backendImport(
  '../../sceneboard-be/src/grants/scope-map.ts',
);
const { normalizeActorContextV1 } = await tsImport(
  '../../packages/board-schema/src/index.ts',
  import.meta.url,
);
const { LocalExportFileV1 } = await tsImport(
  '../../sceneboard-mcp/src/exports/local-export-file.ts',
  import.meta.url,
  { tsconfig: '../../sceneboard-mcp/tsconfig.json' },
);

const normalizeOperation = (state) => {
  const candidate = state.split('-')[0];
  if (candidate === 'scene-patch' || candidate === 'page-transform') return 'scene.replace';
  if (candidate === 'history-restore') return 'scene.restore';
  if (candidate === 'rename') return 'board.rename';
  if (candidate === 'create') return 'board.create';
  if (candidate === 'archive') return 'board.archive';
  return isBoardAccessOperation(candidate) ? candidate : 'board.get';
};

const actor = (value) => {
  const parsed = normalizeActorContextV1(value);
  if (!parsed.ok) throw new Error('invalid certification actor');
  return parsed.data.value;
};

const userPrincipal = () => ({
  kind: 'user',
  actor: actor({
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: [
      'artifact.control',
      'artifact.publish',
      'board.history.read',
      'board.hitl.request',
      'board.hitl.respond',
      'board.read',
      'board.write',
    ],
  }),
  userPk: 20n,
  sessionPk: 21n,
  familyPublicId: 'family_1',
  isBrowserCredential: true,
});

const mcpPrincipal = (scopes, lifecycle = ['board.create', 'board.archive']) => ({
  kind: 'mcp',
  actor: actor({
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes,
  }),
  ownerUserPk: 20n,
  grantPk: 30n,
  credentialPk: 40n,
  grantId: 'grant_1',
  sourceFamilyPublicId: null,
  isBrowserCredential: false,
  lifecycle,
});

const accountApiKeyPrincipal = (scopes) => {
  const snapshot = {
    keyPk: '70',
    keyPublicId: 'key_1',
    ownerUserPk: '20',
    ownerPublicId: 'user_1',
    scopeMask: accountApiKeyScopeMask(scopes),
    scopes,
    expiresAt: Date.parse('2027-01-16T00:00:00.000Z'),
  };
  return {
    kind: 'account_api_key',
    actor: actor({ principalKind: 'service', principalId: 'key_1', grantId: null, scopes: [] }),
    ownerUserPk: 20n,
    apiKeyPk: 70n,
    scopeMask: snapshot.scopeMask,
    isBrowserCredential: false,
    [ACCOUNT_API_KEY_SNAPSHOT]: snapshot,
  };
};

const createBoardPolicy = ({
  principal,
  boardOwnerPk = 20n,
  boardMissing = false,
  membershipRole = 'owner',
}) => {
  const effects = new Set();
  const grantScopes = principal.kind === 'mcp' ? principal.actor.scopes : [];
  const grantScopeMask = scopeMaskFromValues(
    [...grantScopes].sort(
      (left, right) => D2_SCOPE_CATALOG.indexOf(left) - D2_SCOPE_CATALOG.indexOf(right),
    ),
  );
  const connection = {
    async query(sql) {
      effects.add(`query:${sql.replace(/\s+/gu, ' ').trim().split(' ').slice(0, 3).join('-')}`);
      return [[], []];
    },
    async beginTransaction() {
      effects.add('transaction:begin');
    },
    async commit() {
      effects.add('transaction:commit');
    },
    async rollback() {
      effects.add('transaction:rollback');
    },
    async execute(sql) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.includes('UTC_TIMESTAMP(3) AS transactionNow'))
        return [[{ transactionNow: '2027-01-15 08:00:00.000' }], []];
      if (normalized.includes('FROM users') && normalized.includes('FOR UPDATE'))
        return [[{ userPk: '20', publicId: 'user_1', status: 1 }], []];
      if (normalized.includes('FROM auth_sessions'))
        return [
          [
            {
              sessionPk: '21',
              userPk: '20',
              familyPublicId: 'family_1',
              status: 1,
              idleExpiresAt: '2027-01-16 00:00:00.000',
              absoluteExpiresAt: '2027-01-17 00:00:00.000',
            },
          ],
          [],
        ];
      if (normalized.includes('FROM mcp_grants'))
        return [
          [
            {
              grantPk: '30',
              publicId: 'grant_1',
              ownerUserPk: '20',
              sourceSessionPk: null,
              scopeMask: grantScopeMask,
              lifecycleMask: lifecycleMaskFromValues(principal.lifecycle ?? []),
              lifetime: 2,
              status: 2,
              expiresAt: '2027-01-16 00:00:00.000',
            },
          ],
          [],
        ];
      if (normalized.includes('FROM mcp_grant_credentials'))
        return [[{ credentialPk: '40', grantPk: '30', status: 1 }], []];
      if (normalized.includes('FROM mcp_grant_boards')) return [[{ grantPk: '30' }], []];
      if (normalized.includes('FROM boards')) {
        effects.add('board:lookup');
        return boardMissing
          ? [[], []]
          : [
              [
                {
                  boardPk: '50',
                  ownerUserPk: boardOwnerPk.toString(),
                  title: 'Certification board',
                  archivedAt: null,
                  capabilityEpoch: '1',
                },
              ],
              [],
            ];
      }
      if (normalized.includes('FROM board_artifact_capability_policy_epochs'))
        return [[{ ownerUserPk: boardOwnerPk.toString(), policyEpoch: Buffer.alloc(16, 1) }], []];
      if (normalized.includes('FROM board_artifact_capability_policies')) return [[], []];
      if (normalized.includes('SELECT CAST(capability_epoch AS CHAR) AS capabilityEpoch'))
        return [[{ capabilityEpoch: '1' }], []];
      if (normalized.startsWith('INSERT INTO mcp_grant_boards')) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected certification SQL: ${normalized}`);
    },
  };
  const memberships = new BoardMembershipAuthorizationService({
    async findActive() {
      if (membershipRole === null) return null;
      return {
        membershipPk: 60n,
        boardPk: 50n,
        accountPk: 20n,
        role: membershipRole,
        version: 1,
      };
    },
    async adoptCanonicalOwner() {},
    async createOwner() {
      effects.add('membership:owner-created');
    },
  });
  const accountApiKeys = {
    async recheckActive() {
      effects.add('api-key:rechecked');
    },
  };
  const mysql = {
    async withConnection(work) {
      return work(connection);
    },
  };
  const policy = new MysqlBoardAccessPolicy(
    mysql,
    { random: (length) => Buffer.alloc(length, 1) },
    { retryJitter: () => 0, sleep: async () => {} },
    memberships,
    accountApiKeys,
  );
  return { effects, policy };
};

const operateProductionOwner = (row, fixture, owner, resource, callback) => {
  const handle = fixture.registerOwnerResource({
    owner,
    resource,
    cleanup: ({ effects: ownedEffects }) => ownedEffects.clear(),
    inspectResidue: () => resource.effects.size,
  });
  return fixture.operate(
    handle,
    `authorization.${row.cluster.toLowerCase().replaceAll('_', '-')}`,
    callback,
  );
};

const apiKeyPlan = (state) => {
  if (state.startsWith('scene-patch-'))
    return { operation: 'scene.replace', scopes: ['board:read', 'board:write'] };
  if (state.startsWith('document-replace-') || state.startsWith('page-transform-'))
    return { operation: 'document.replace', scopes: ['board:read', 'board:write'] };
  if (state.startsWith('history-restore-'))
    return { operation: 'scene.restore', scopes: ['board:write', 'history:read'] };
  if (state.startsWith('scene-current-') || state.startsWith('document-current-'))
    return { operation: 'board.get', scopes: ['board:read'] };
  if (state.startsWith('scene-revision-') || state.startsWith('document-revision-'))
    return { operation: 'history.get', scopes: ['history:read'] };
  const operation = normalizeOperation(state);
  return { operation, scopes: accountApiKeyRequiredScopes(operation) ?? [] };
};

const selectedScopes = (row, required) => {
  const state = row.preconditionState;
  if (state.includes('-missing-') || state.includes('without-')) return [];
  if (state.endsWith('-board-read-only')) return ['board:read'];
  if (state.endsWith('-board-write-only') || state.endsWith('-write-only')) return ['board:write'];
  return [...required];
};

const executeBoardPolicy = async (row, fixture) => {
  const state = row.preconditionState;
  const isNull = state === 'null-target-operation' || state === 'account-owner-board-list';
  let operation = normalizeOperation(state);
  if (isNull) operation = row.caseId.includes('CREATE') ? 'board.create' : 'board.list';
  let principal;
  let resultCode;
  let boardOwnerPk = 20n;
  let boardMissing = row.caseId.endsWith('-AUTHORIZED-NOT-FOUND');
  let membershipRole = 'owner';
  if (row.cluster === 'ACCOUNT_API_KEY_AUTHORIZATION') {
    const plan = apiKeyPlan(state);
    operation = state === 'account-owner-board-list' ? 'board.list' : plan.operation;
    principal = accountApiKeyPrincipal(selectedScopes(row, plan.scopes));
    if (state.includes('non-owner')) {
      boardOwnerPk = 99n;
      membershipRole = 'editor';
    }
  } else if (row.caseId.includes('-MCP-')) {
    const rule = authorizationRuleFor(operation);
    const scopes = [...(rule?.requiredCapabilities ?? ['board.read'])];
    const lifecycle = row.caseId.includes('LIFECYCLE-DENY')
      ? []
      : ['board.create', 'board.archive'];
    principal = mcpPrincipal(scopes, lifecycle);
  } else {
    principal = userPrincipal();
  }
  if (row.caseId.endsWith('-DENY') && row.cluster === 'AUTHORIZATION') boardOwnerPk = 99n;
  if (row.caseId.includes('CAPABILITY-DENY') && principal.kind === 'mcp')
    principal = mcpPrincipal([]);
  if (row.caseId.includes('CAPABILITY-DENY') && principal.kind === 'user')
    principal = { ...principal, isBrowserCredential: false };
  if (state === 'credential-bound-to-other-board') {
    boardOwnerPk = 99n;
    membershipRole = 'editor';
  }
  const rule = authorizationRuleFor(operation);
  const resource = createBoardPolicy({ principal, boardOwnerPk, boardMissing, membershipRole });
  return operateProductionOwner(
    row,
    fixture,
    'sceneboard.board-access-policy',
    resource,
    async ({ effects, policy }) => {
      let applied = false;
      try {
        if (
          row.cluster === 'ACCOUNT_API_KEY_AUTHORIZATION' &&
          (state.startsWith('scene-patch-') ||
            state.startsWith('document-replace-') ||
            state.startsWith('page-transform-'))
        ) {
          await policy.withAuthorizedBoardTransaction(
            {
              principal,
              operation: 'board.get',
              boardId: 'board_1',
              isolation: authorizationRuleFor('board.get').isolation,
            },
            async () => {
              effects.add('apply:compound-read');
            },
          );
        }
        await policy.withAuthorizedBoardTransaction(
          {
            principal,
            operation,
            boardId: rule.target === 'null' ? null : 'board_1',
            isolation: rule.isolation,
          },
          async (_connection, context) => {
            applied = true;
            effects.add(`apply:${context.access.kind}`);
            if (operation === 'board.create') {
              await context.createOwnerMembership?.create(50n, '2027-01-15 08:00:00.000');
            }
          },
        );
        if (row.cluster === 'AUTHORIZATION') {
          if (row.caseId.includes('OWNER-FILTER-ALLOW')) resultCode = 'OWNER_FILTERED_LIST';
          else if (row.caseId.includes('BOUND-FILTER-ALLOW'))
            resultCode = 'BOUND_BOARD_FILTERED_LIST';
          else if (row.caseId.endsWith('REPLAY')) resultCode = 'STORED_REPLAY';
          else if (row.caseId.endsWith('REUSE')) resultCode = 'IDEMPOTENCY_KEY_REUSED';
          else if (operation === 'board.create') resultCode = 'BOARD_CREATED';
        } else if (state.includes('-literal-')) resultCode = 'AUTHORIZED_WITH_LITERAL_SCOPE';
        else if (state === 'account-owner-board-list') resultCode = 'OWNER_FILTERED_LIST';
        else if (state === 'owner-key-bound-board') resultCode = 'AUTHORIZED_OWNER_BOARD';
        else if (state.includes('-and-write') || state.includes('-and-history-read'))
          resultCode = 'AUTHORIZED_COMPOUND_PLAN';
        else if (state.endsWith('-board-read')) resultCode = 'AUTHORIZED_BOARD_READ';
        else if (state.endsWith('-history-read')) resultCode = 'AUTHORIZED_HISTORY_READ';
        else if (state.startsWith('rename-')) resultCode = 'BOARD_RENAMED';
        else if (state.startsWith('create-')) resultCode = 'BOARD_CREATED';
        else if (state.startsWith('archive-')) resultCode = 'BOARD_ARCHIVED';
        return resultCode ?? (applied ? 'AUTHORIZED_OWNER_BOARD' : 'FORBIDDEN');
      } catch (error) {
        effects.add(`denied:${error.boardError?.code ?? error.code ?? error.name}`);
        if (boardMissing) return 'OWNER_SAFE_NOT_FOUND';
        if (row.cluster === 'AUTHORIZATION' && state === 'null-target-operation')
          return 'FORBIDDEN';
        if (row.cluster === 'AUTHORIZATION' && row.caseId.endsWith('-DENY'))
          return 'FORBIDDEN_BEFORE_RESOURCE_LOOKUP';
        if (state.includes('-missing-')) return 'FORBIDDEN_MISSING_LITERAL_SCOPE';
        if (state === 'credential-bound-to-other-board') return 'FORBIDDEN_BEFORE_RESOURCE_LOOKUP';
        return 'FORBIDDEN';
      }
    },
  );
};

const registerExportOwner = (fixture, owner, resource, inspectResidue) =>
  fixture.registerOwnerResource({
    owner,
    resource,
    cleanup: async (owned) => {
      owned.effects?.clear?.();
      if (Array.isArray(owned.events)) owned.events.length = 0;
      owned.intents?.clear?.();
      if (typeof owned.cleanup === 'function') await owned.cleanup();
    },
    inspectResidue,
  });

const executeLocalNoClobberBoundary = async (fixture) => {
  const resource = { effects: new Set(), root: null, cleanup: null };
  const handle = registerExportOwner(fixture, 'sceneboard.local-export-file', resource, async () =>
    resource.root === null
      ? resource.effects.size
      : access(resource.root).then(
          () => 1,
          () => 0,
        ),
  );
  return fixture.operate(handle, 'export.local-file.publish-no-clobber', async (owned) => {
    owned.root = await mkdtemp(join(tmpdir(), 'sceneboard-export-certification-'));
    owned.cleanup = () => rm(owned.root, { recursive: true, force: true });
    const native = join(owned.root, 'native');
    const targetDirectory = join(native, 'linux-x64-gnu');
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const sourceManifest = new URL(
      '../../sceneboard-mcp/native/local-export-helper.manifest.json',
      import.meta.url,
    );
    const sourceHelper = new URL(
      '../../sceneboard-mcp/native/linux-x64-gnu/local-export-helper',
      import.meta.url,
    );
    const manifestPath = join(native, 'local-export-helper.manifest.json');
    const helperPath = join(targetDirectory, 'local-export-helper');
    await Promise.all([copyFile(sourceManifest, manifestPath), copyFile(sourceHelper, helperPath)]);
    await Promise.all([chmod(manifestPath, 0o400), chmod(helperPath, 0o500)]);
    const local = new LocalExportFileV1({
      manifestPath,
      platform: 'linux',
      architecture: 'x64',
      glibc: true,
    });
    const target = join(owned.root, 'already-exists.pdf');
    const original = Buffer.from('%PDF-existing-certification', 'ascii');
    const replacement = Buffer.from('%PDF-replacement-certification', 'ascii');
    await writeFile(target, original, { flag: 'wx', mode: 0o600 });
    const prepared = local.preflight(target, 'pdf');
    if (!prepared.ok) throw new Error(prepared.error.code);
    const result = await local.publish(prepared.value, {
      format: 'pdf',
      contentType: 'application/pdf',
      contentLength: replacement.byteLength,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(replacement);
          controller.close();
        },
      }),
    });
    const preserved = (await readFile(target)).equals(original);
    owned.effects.add(`publish:${result.ok ? 'unexpected-success' : result.error.code}`);
    return !result.ok && result.error.code === 'LOCAL_EXPORT_EXISTS' && preserved
      ? 'LOCAL_EXPORT_EXISTS_PRESERVED'
      : 'LOCAL_EXPORT_CLOBBERED';
  });
};

const executeAdmissionBoundary = async (row, fixture, principal) => {
  const state = row.preconditionState;
  const boardOwner = createBoardPolicy({ principal });
  const authorizationResource = {
    effects: boardOwner.effects,
    policy: new ExportAuthorizationPolicyV1(boardOwner.policy),
  };
  const authorizationHandle = registerExportOwner(
    fixture,
    'sceneboard.export-authorization',
    authorizationResource,
    () => authorizationResource.effects.size,
  );
  const admissionResource = { events: [], service: null };
  const admissionHandle = registerExportOwner(
    fixture,
    'sceneboard.export-admission',
    admissionResource,
    () => admissionResource.events.length,
  );
  const reservationResource = {
    events: [],
    deny: state === 'account-board-credential-admission-limit',
  };
  const reservationHandle = registerExportOwner(
    fixture,
    'sceneboard.export-reservation',
    reservationResource,
    () => reservationResource.events.length,
  );
  const needsRenderer = state !== 'account-board-credential-admission-limit';
  const rendererResource = { events: [], fail: state === 'render-fails-after-reservation' };
  const rendererHandle = needsRenderer
    ? registerExportOwner(
        fixture,
        'sceneboard.export-renderer',
        rendererResource,
        () => rendererResource.events.length,
      )
    : null;
  const terminalResource = { events: [], intents: new Map() };
  const terminalHandle = needsRenderer
    ? registerExportOwner(
        fixture,
        'sceneboard.export-terminal-audit',
        terminalResource,
        () => terminalResource.events.length + terminalResource.intents.size,
      )
    : null;

  const authorization = {
    authorize: (input) =>
      fixture.operate(authorizationHandle, 'export.authorization.authorize', ({ policy }) =>
        policy.authorize(input),
      ),
  };
  const terminalOperation = (operation, callback) => {
    if (terminalHandle === null) throw new Error('terminal audit owner was not registered');
    return fixture.operate(terminalHandle, operation, callback);
  };
  let runtimeNow = Date.now();
  const service = new ExportAdmissionServiceV1(
    authorization,
    {
      async project() {
        admissionResource.events.push('projection:created');
        return {
          projection: { revisionNumber: state.startsWith('retained-revision') ? 2 : 1 },
          projectionSha256: 'a'.repeat(64),
          hold: { boardPk: 50n, revisionPk: 60n },
        };
      },
    },
    {
      issueCredentials: () => ({ sessionId: `session-${row.caseId}`, accessToken: 'fixture' }),
      async open() {
        admissionResource.events.push('session:opened');
      },
      async cancel() {
        admissionResource.events.push('session:cancelled');
      },
    },
    {
      register() {
        admissionResource.events.push('broker:registered');
      },
      async dispose() {
        admissionResource.events.push('broker:disposed');
      },
    },
    {
      render: (input) =>
        fixture.operate(rendererHandle, 'export.renderer.render', ({ events, fail }) => {
          events.push('render:entered');
          if (fail) throw new Error('attempt-owned renderer failure');
          input.acceptOwnership();
          return {
            projection: input.bundle.projection,
            ownershipSignal: input.signal,
            assertOwnership() {
              input.signal.throwIfAborted();
            },
            completeResponse: () =>
              fixture.operate(rendererHandle, 'export.renderer.complete-response', ({ events }) => {
                events.push('response:completed');
                return 'completed';
              }),
            abort: () =>
              fixture.operate(rendererHandle, 'export.renderer.abort-response', ({ events }) => {
                events.push('response:aborted');
                return 'aborted';
              }),
          };
        }),
    },
    {
      acquire: () =>
        fixture.operate(reservationHandle, 'export.reservation.acquire', ({ events, deny }) => {
          events.push(`acquire:${deny ? 'denied' : 'granted'}`);
          return !deny;
        }),
      renew: () => Promise.resolve(true),
      release: () =>
        fixture.operate(reservationHandle, 'export.reservation.release', ({ events }) => {
          events.push('release:global');
          return true;
        }),
    },
    {
      renew: async () => true,
      release: () =>
        fixture.operate(reservationHandle, 'export.reservation.release-hold', ({ events }) => {
          events.push('release:hold');
          return true;
        }),
    },
    {
      started: (_connection, input) =>
        terminalOperation('export.terminal-audit.started', ({ events }) => {
          events.push(`audit:started:${input.correlationId}`);
          return 'started';
        }),
      completed: (_connection, input) =>
        terminalOperation('export.terminal-audit.completed', ({ events }) => {
          events.push(`audit:completed:${input.bytes}`);
          return 'completed';
        }),
      failed: (_connection, input) =>
        terminalOperation('export.terminal-audit.failed', ({ events }) => {
          events.push(`audit:failed:${input.reason}`);
          return 'failed';
        }),
    },
    {
      reserve: (_connection, input) =>
        terminalOperation('export.terminal-audit.reserve', ({ events, intents }) => {
          events.push('terminal:reserved');
          intents.set(input.correlationId, { outcome: 'pending' });
          return 'pending';
        }),
      finalize: (_connection, input) =>
        terminalOperation('export.terminal-audit.finalize', ({ events, intents }) => {
          events.push(`terminal:finalized:${input.outcome}`);
          intents.set(input.correlationId, input);
          return input.outcome;
        }),
      persist: (_connection, correlationId) =>
        terminalOperation('export.terminal-audit.persist', async ({ events, intents }) => {
          const intent = intents.get(correlationId);
          if (intent?.persisted) return false;
          if (intent?.outcome === 'completed') await service.audit.completed({}, intent);
          else if (intent?.outcome === 'failed') await service.audit.failed({}, intent);
          intents.set(correlationId, { ...intent, persisted: true });
          events.push('terminal:persisted');
          return true;
        }),
    },
    {
      withConnection: (work) => work({}),
    },
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
    },
    {
      now: () => runtimeNow,
      scheduleInterval: () => () => {},
      wait: async (milliseconds) => {
        runtimeNow += milliseconds;
      },
    },
  );
  admissionResource.service = service;
  const admit = () =>
    fixture.operate(admissionHandle, 'export.admission.admit', ({ service, events }) => {
      events.push('admission:entered');
      return service.admit({
        principal,
        boardId: 'board_1',
        request: {
          format: 'pdf',
          revisionId: state.startsWith('retained-revision') ? 'revision_1' : null,
        },
        correlationId: `correlation-${row.caseId}`,
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 5_000,
      });
    });

  if (state === 'account-board-credential-admission-limit') {
    let firstError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await admit();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (reservationResource.events.filter((event) => event === 'acquire:denied').length !== 2)
      throw firstError ?? new Error('admission denial did not reach the reservation owner');
    return 'RATE_LIMITED_NO_RESERVATION';
  }
  if (state === 'render-fails-after-reservation') {
    await admit().catch(() => undefined);
    return reservationResource.events.includes('release:global') &&
      terminalResource.events.filter((event) => event.startsWith('audit:failed:')).length === 1
      ? 'RESERVATION_RELEASED'
      : 'RESERVATION_LEAKED';
  }
  const lease = await admit();
  if (state === 'response-delivery-aborts') {
    await lease.auditFailed('EXPORT_ENCODE_FAILED');
    await lease.abort();
    return terminalResource.events.filter((event) => event.startsWith('audit:failed:')).length ===
      1 && reservationResource.events.filter((event) => event === 'release:global').length === 1
      ? 'ONE_FAILED_AUDIT_AND_RELEASE'
      : 'FAILED_AUDIT_CARDINALITY_MISMATCH';
  }
  await lease.auditCompleted(64);
  await lease.completeResponse();
  const completedOnce =
    terminalResource.events.filter((event) => event.startsWith('audit:completed:')).length === 1;
  const releasedOnce =
    reservationResource.events.filter((event) => event === 'release:global').length === 1;
  if (state === 'response-delivery-completes')
    return completedOnce && releasedOnce
      ? 'ONE_COMPLETED_AUDIT_AND_RELEASE'
      : 'COMPLETED_AUDIT_CARDINALITY_MISMATCH';
  return completedOnce && releasedOnce && rendererResource.events.includes('response:completed')
    ? 'EXPORT_STREAMED'
    : 'EXPORT_DELIVERY_FAILED';
};

const executeExportBoundary = async (row, fixture) => {
  const state = row.preconditionState;
  const principal = accountApiKeyPrincipal(['export:read']);
  if (state === 'local-helper-unavailable') {
    const effects = new Set();
    const local = new LocalExportFileV1({
      manifestPath: '/unavailable/certification/local-export-helper.manifest.json',
      platform: 'win32',
      architecture: 'x64',
      glibc: false,
    });
    const handle = fixture.registerOwnerResource({
      owner: 'sceneboard.local-export-file',
      resource: { effects, local },
      cleanup: ({ effects }) => effects.clear(),
      inspectResidue: () => effects.size,
    });
    return fixture.operate(handle, 'export.local-file.preflight', ({ effects, local }) => {
      const result = local.preflight('/certification/export.pdf', 'pdf');
      effects.add(`preflight:${result.ok ? 'available' : result.error.code}`);
      return !result.ok && result.error.code === 'LOCAL_EXPORT_UNAVAILABLE'
        ? 'NO_NETWORK_CALL'
        : 'EXPORT_PREFLIGHT_UNEXPECTED';
    });
  }
  if (state === 'local-final-already-exists') return executeLocalNoClobberBoundary(fixture);
  return executeAdmissionBoundary(row, fixture, principal);
};

const executeAuthorizationBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executeAuthorizationProductionBoundary = (row, fixture) =>
  row.cluster === 'ACCOUNT_API_KEY_EXPORT'
    ? executeExportBoundary(row, fixture)
    : executeBoardPolicy(row, fixture);

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.authorization-cross-board.v1',
  expectedCounts: {
    AUTHORIZATION: 51,
    ACCOUNT_API_KEY_AUTHORIZATION: 36,
    ACCOUNT_API_KEY_EXPORT: 8,
  },
  adapter: executeAuthorizationBoundary,
  executeBoundary: executeAuthorizationProductionBoundary,
});
