import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  readJson,
  sha256,
} from './canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const catalogPath = resolve(root, 'test/certification/security-case-catalog.v1.json');
const rowKeys = [
  'caseId',
  'cluster',
  'upstreamContractId',
  'upstreamFixtureId',
  'upstreamFixtureSha256',
  'principalKind',
  'preconditionState',
  'expectedCodeOrState',
  'precedence',
  'testFile',
  'cleanupAssertion',
  'evidenceRowId',
  'transportOnlyCanaryAllowance',
  'evidenceClass',
];
const tag = (value) =>
  value.replaceAll('.', '-').replaceAll('_', '-').replaceAll(':', '-').toUpperCase();

const stringArrayInitializer = (source, name) => {
  const start = source.indexOf(`export const ${name} = [`);
  const end = source.indexOf('] as const', start);
  if (start < 0 || end < 0) throw new CertificationError('SECURITY_CASE_CATALOG_DRIFT');
  return [...source.slice(start, end).matchAll(/'([^']+)'/gu)].map((match) => match[1]);
};

const observeToolRegistries = (source) => {
  const core = stringArrayInitializer(source, 'CORE_TOOL_NAMES_V1');
  const downstream = stringArrayInitializer(source, 'DOWNSTREAM_TOOL_NAMES_V1');
  const accountApiKey = stringArrayInitializer(source, 'API_KEY_TOOL_NAMES_V1');
  const registered = [...source.matchAll(/\badd\(\s*'([^']+)'/gu)].map((match) => match[1]);
  const generalDeclared = [...core, ...downstream];
  const accountOnly = new Set(accountApiKey.filter((name) => !generalDeclared.includes(name)));
  const general = registered.filter((name) => !accountOnly.has(name));
  const exactSet = (left, right) =>
    left.length === right.length && left.every((name) => right.includes(name));
  if (
    core.length !== 24 ||
    general.length !== 30 ||
    accountApiKey.length !== 22 ||
    new Set(general).size !== general.length ||
    new Set(accountApiKey).size !== accountApiKey.length ||
    !exactSet(general, generalDeclared)
  )
    throw new CertificationError('SECURITY_CASE_CATALOG_DRIFT');
  return {
    general,
    accountApiKey,
    generalDiscoveryCuts: [3, core.length, general.length],
  };
};

export const buildExpectedSecurityCatalog = async () => {
  const [manifestBytes, { value: inventory }, toolRegistrySource] = await Promise.all([
    readFile(resolve(root, 'test/certification/contract-manifest.v1.json')),
    readJson(resolve(root, 'test/certification/contract-input-inventory.v1.json')),
    readFile(resolve(root, 'sceneboard-mcp/src/tools/register-tools.ts'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifestSha256 = sha256(manifestBytes);
  const resourceHash = new Map(
    manifest.resources.map(({ canonicalPath, fingerprintSha256 }) => [
      canonicalPath,
      fingerprintSha256,
    ]),
  );
  const cases = [];
  const toolRegistries = observeToolRegistries(toolRegistrySource);
  const add = ({
    caseId,
    cluster,
    owner,
    testFile,
    preconditionState,
    expectedCodeOrState,
    principalKind = 'system-fixture',
    upstreamContractId = `${owner}-PUBLIC-CONTRACT`,
    upstreamFixtureId = 'contract-manifest.v1',
    upstreamFixtureSha256 = manifestSha256,
    precedence = 'owner-defined-fail-closed',
    transportOnlyCanaryAllowance = [],
  }) =>
    cases.push({
      caseId,
      cluster,
      upstreamContractId,
      upstreamFixtureId,
      upstreamFixtureSha256,
      principalKind,
      preconditionState,
      expectedCodeOrState,
      precedence,
      testFile,
      cleanupAssertion: 'exact-owned-fixture-clean',
      evidenceRowId: `SEC-${caseId}`,
      transportOnlyCanaryAllowance,
      evidenceClass: 'live-required',
    });

  const auth = [
    ['AUTH-P01', 'signup-login-initial-session', 'SESSION_CURRENT'],
    ['AUTH-P02', 'session-read-current-generation', 'SESSION_CURRENT'],
    ['AUTH-P03', 'renew-rotates-generation', 'SESSION_GENERATION_ROTATED'],
    ['AUTH-P04', 'logout-terminalizes-family', 'SESSION_TERMINAL'],
    ['AUTH-N01', 'foreign-origin', 'ORIGIN_DENIED'],
    ['AUTH-N02', 'missing-origin', 'ORIGIN_REQUIRED'],
    ['AUTH-N03', 'missing-csrf-cookie', 'CSRF_DENIED'],
    ['AUTH-N04', 'missing-csrf-header', 'CSRF_DENIED'],
    ['AUTH-N05', 'csrf-cookie-header-mismatch', 'CSRF_DENIED'],
    ['AUTH-N06', 'stale-csrf-after-renewal', 'CSRF_DENIED'],
    ['AUTH-N07', 'csrf-from-other-family', 'CSRF_DENIED'],
    ['AUTH-N08', 'missing-session-cookie', 'UNAUTHENTICATED'],
    ['AUTH-N09', 'malformed-session-cookie', 'UNAUTHENTICATED'],
    ['AUTH-N10', 'expired-session', 'UNAUTHENTICATED'],
    ['AUTH-N11', 'disabled-user', 'FORBIDDEN'],
    ['AUTH-N12', 'old-generation-after-renewal', 'UNAUTHENTICATED'],
    ['AUTH-N13', 'old-generation-after-logout', 'UNAUTHENTICATED'],
    ['AUTH-N14', 'presented-rotated-token-reuse-cascade', 'SESSION_FAMILY_REVOKED'],
  ];
  auth.forEach(([caseId, preconditionState, expectedCodeOrState]) =>
    add({
      caseId,
      cluster: 'AUTH_SESSION',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState,
      expectedCodeOrState,
      principalKind: 'browser-user',
      upstreamContractId: 'D2-AUTH-SESSION-V1',
      precedence: 'parse-rate-credential-origin-csrf-authorization',
    }),
  );

  [
    ['ACTIVE-VALID', 'active-exact-bearer', 'ACCOUNT_API_KEY_AUTHENTICATED'],
    ['MISSING', 'missing-bearer', 'UNAUTHENTICATED'],
    ['MALFORMED', 'malformed-bearer', 'UNAUTHENTICATED'],
    ['UNKNOWN', 'unknown-key-digest', 'UNAUTHENTICATED'],
    ['REVOKED', 'revoked-key', 'UNAUTHENTICATED'],
    ['EXPIRED', 'expired-key', 'UNAUTHENTICATED'],
    ['DISABLED-ACCOUNT', 'disabled-owner-account', 'FORBIDDEN'],
    ['RATE-LIMITED', 'authentication-failure-bucket-saturated', 'RATE_LIMITED'],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    add({
      caseId: `APIKEY-AUTH-${axis}`,
      cluster: 'ACCOUNT_API_KEY_AUTHENTICATION',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState,
      expectedCodeOrState,
      principalKind: 'account-api-key',
      upstreamContractId: 'D2-ACCOUNT-API-KEY-AUTH-V1',
      precedence: 'parse-rate-credential-authorization',
    }),
  );

  const ownerStates = [
    'CREATED',
    'PENDING',
    'APPROVED',
    'REDEEMED',
    'DENIED',
    'CANCELLED',
    'EXPIRED',
    'LOCKED',
  ];
  ownerStates.forEach((state) =>
    add({
      caseId: `PAIR-OWNER-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState: `200_PAIRING_OWNER_STATUS_${state}`,
      principalKind: 'browser-owner',
      upstreamContractId: 'D2-PAIRING-OWNER-V1',
    }),
  );
  ['PENDING', 'APPROVED', 'REDEEMED', 'DENIED', 'CANCELLED', 'EXPIRED'].forEach((state) =>
    add({
      caseId: `PAIR-CLIENT-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState: `200_PAIRING_CLIENT_STATUS_${state}`,
      principalKind: 'mcp-proof-client',
      upstreamContractId: 'D2-PAIRING-CLIENT-V1',
    }),
  );
  ['UNKNOWN-ID', 'MALFORMED', 'MISMATCH', 'UNCLAIMED'].forEach((state) =>
    add({
      caseId: `PAIR-CLIENT-PROOF-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState: '401_PAIRING_PROOF_INVALID',
      principalKind: 'mcp-proof-client',
      upstreamContractId: 'D2-PAIRING-PROOF-V1',
    }),
  );
  const redeem = new Map([
    ['PENDING', '409_PAIRING_NOT_READY'],
    ['APPROVED', '200_GRANT_CREDENTIAL_RESPONSE'],
    ['DENIED', '410_PAIRING_TERMINAL'],
    ['CANCELLED', '410_PAIRING_TERMINAL'],
    ['EXPIRED', '410_PAIRING_TERMINAL'],
    ['REDEEMED', '410_PAIRING_TERMINAL'],
    ['INVALID-PROOF', '401_PAIRING_PROOF_INVALID'],
  ]);
  for (const [state, expectedCodeOrState] of redeem)
    add({
      caseId: `PAIR-REDEEM-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState,
      principalKind: 'mcp-proof-client',
      upstreamContractId: 'D2-PAIRING-REDEEM-V1',
    });
  ['PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED'].forEach((state) =>
    add({
      caseId: `PAIR-GRANT-REVOKE-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState: '204_GRANT_REVOKE_RESULT',
      principalKind: 'browser-owner',
      upstreamContractId: 'D2-GRANT-LIFECYCLE-V1',
    }),
  );
  ['ACTIVE', 'PENDING', 'REVOKED', 'EXPIRED'].forEach((state) =>
    add({
      caseId: `PAIR-GRANT-ROTATE-${state}`,
      cluster: 'PAIRING',
      owner: 'D2',
      testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
      preconditionState: state,
      expectedCodeOrState:
        state === 'ACTIVE' ? '200_GRANT_CREDENTIAL_RESPONSE' : '409_GRANT_NOT_ACTIVE',
      principalKind: 'browser-owner',
      upstreamContractId: 'D2-GRANT-LIFECYCLE-V1',
    }),
  );

  const operations = [
    'board.get',
    'capabilities.get',
    'board.archive',
    'scene.replace',
    'scene.clear',
    'scene.restore',
    'history.list',
    'history.get',
    'hitl.request',
    'hitl.respond',
    'hitl.read',
    'artifact.get',
    'artifact.publish',
    'artifact.stop',
  ];
  for (const operation of operations) {
    const operationTag = tag(operation);
    for (const principalKind of ['USER', 'MCP'])
      add({
        caseId: `AUTHZ-${operationTag}-${principalKind}-DENY`,
        cluster: 'AUTHORIZATION',
        owner: 'D2',
        testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
        preconditionState: `${operation}-cross-board-current-credential`,
        expectedCodeOrState: 'FORBIDDEN_BEFORE_RESOURCE_LOOKUP',
        principalKind: principalKind === 'USER' ? 'browser-user' : 'mcp-grant',
        upstreamContractId: 'D2-AUTHORIZATION-ORDER-V1',
        precedence: 'authorization-before-resource-and-idempotency',
      });
    add({
      caseId: `AUTHZ-${operationTag}-AUTHORIZED-NOT-FOUND`,
      cluster: 'AUTHORIZATION',
      owner: 'D3',
      testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      preconditionState: `${operation}-authorized-missing-resource`,
      expectedCodeOrState: 'OWNER_SAFE_NOT_FOUND',
      principalKind: 'authorized-principal',
      upstreamContractId: 'D2-D3-AUTHORIZED-RESOURCE-V1',
      precedence: 'authorization-then-real-resource-lookup',
    });
  }
  const nullCases = [
    ['AUTHZ-NULL-LIST-USER-OWNER-FILTER-ALLOW', 'OWNER_FILTERED_LIST'],
    ['AUTHZ-NULL-LIST-MCP-BOUND-FILTER-ALLOW', 'BOUND_BOARD_FILTERED_LIST'],
    ['AUTHZ-NULL-LIST-USER-CAPABILITY-DENY', 'FORBIDDEN'],
    ['AUTHZ-NULL-LIST-MCP-CAPABILITY-DENY', 'FORBIDDEN'],
    ['AUTHZ-NULL-CREATE-USER-CAPABILITY-ALLOW', 'BOARD_CREATED'],
    ['AUTHZ-NULL-CREATE-MCP-LIFECYCLE-ALLOW', 'BOARD_CREATED'],
    ['AUTHZ-NULL-CREATE-MCP-LIFECYCLE-DENY', 'FORBIDDEN'],
    ['AUTHZ-NULL-CREATE-IDEMPOTENCY-REPLAY', 'STORED_REPLAY'],
    ['AUTHZ-NULL-CREATE-IDEMPOTENCY-REUSE', 'IDEMPOTENCY_KEY_REUSED'],
  ];
  nullCases.forEach(([caseId, expectedCodeOrState]) =>
    add({
      caseId,
      cluster: 'AUTHORIZATION',
      owner: 'D2',
      testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      preconditionState: 'null-target-operation',
      expectedCodeOrState,
      principalKind: caseId.includes('-MCP-') ? 'mcp-grant' : 'browser-user',
      upstreamContractId: 'D2-NULL-TARGET-AUTHORIZATION-V1',
      precedence: 'capability-before-create-or-filter',
    }),
  );

  const accountApiKeyAuthorizationCase = (
    caseId,
    preconditionState,
    expectedCodeOrState,
    precedence = 'literal-scope-owner-before-resource',
  ) =>
    add({
      caseId,
      cluster: 'ACCOUNT_API_KEY_AUTHORIZATION',
      owner: 'D2',
      testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      preconditionState,
      expectedCodeOrState,
      principalKind: 'account-api-key',
      upstreamContractId: 'D2-ACCOUNT-API-KEY-AUTHORIZATION-V1',
      precedence,
    });
  for (const [scope, operation] of [
    ['board:read', 'board.get'],
    ['board:write', 'board.rename'],
    ['history:read', 'history.get'],
    ['board:create', 'board.create'],
    ['board:archive', 'board.archive'],
    ['export:read', 'export.render'],
  ])
    for (const axis of ['ALLOW', 'DENY'])
      accountApiKeyAuthorizationCase(
        `APIKEY-SCOPE-${tag(scope)}-${axis}`,
        `${operation}-${axis === 'ALLOW' ? `literal-${scope}` : `missing-${scope}`}`,
        axis === 'ALLOW' ? 'AUTHORIZED_WITH_LITERAL_SCOPE' : 'FORBIDDEN_MISSING_LITERAL_SCOPE',
      );
  [
    ['OWNER-BOUND-ALLOW', 'owner-key-bound-board', 'AUTHORIZED_OWNER_BOARD'],
    ['SAME-ACCOUNT-NONOWNER-DENY', 'same-account-non-owner-board', 'FORBIDDEN'],
    ['CROSS-BOARD-DENY', 'credential-bound-to-other-board', 'FORBIDDEN_BEFORE_RESOURCE_LOOKUP'],
    ['LIST-OWNER-FILTERED', 'account-owner-board-list', 'OWNER_FILTERED_LIST'],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    accountApiKeyAuthorizationCase(
      `APIKEY-OWNER-${axis}`,
      preconditionState,
      expectedCodeOrState,
    ),
  );
  [
    ['SCENE-CURRENT-ALLOW', 'scene-current-board-read', 'AUTHORIZED_BOARD_READ'],
    ['SCENE-HISTORICAL-ALLOW', 'scene-revision-history-read', 'AUTHORIZED_HISTORY_READ'],
    ['SCENE-HISTORICAL-BOARD-ONLY-DENY', 'scene-revision-board-read-only', 'FORBIDDEN'],
    ['DOCUMENT-CURRENT-ALLOW', 'document-current-board-read', 'AUTHORIZED_BOARD_READ'],
    ['DOCUMENT-HISTORICAL-ALLOW', 'document-revision-history-read', 'AUTHORIZED_HISTORY_READ'],
    [
      'DOCUMENT-HISTORICAL-BOARD-ONLY-DENY',
      'document-revision-board-read-only',
      'FORBIDDEN',
    ],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    accountApiKeyAuthorizationCase(
      `APIKEY-HISTORICAL-${axis}`,
      preconditionState,
      expectedCodeOrState,
      'revision-discriminator-before-network',
    ),
  );
  [
    ['SCENE-PATCH-ALLOW', 'scene-patch-board-read-and-write', 'AUTHORIZED_COMPOUND_PLAN'],
    ['SCENE-PATCH-WRITE-ONLY-DENY', 'scene-patch-board-write-only', 'FORBIDDEN'],
    [
      'DOCUMENT-REPLACE-ALLOW',
      'document-replace-board-read-and-write',
      'AUTHORIZED_COMPOUND_PLAN',
    ],
    [
      'DOCUMENT-REPLACE-WRITE-ONLY-DENY',
      'document-replace-board-write-only',
      'FORBIDDEN',
    ],
    ['PAGE-TRANSFORM-ALLOW', 'page-transform-board-read-and-write', 'AUTHORIZED_COMPOUND_PLAN'],
    ['PAGE-TRANSFORM-WRITE-ONLY-DENY', 'page-transform-board-write-only', 'FORBIDDEN'],
    [
      'HISTORY-RESTORE-ALLOW',
      'history-restore-board-write-and-history-read',
      'AUTHORIZED_COMPOUND_PLAN',
    ],
    ['HISTORY-RESTORE-WRITE-ONLY-DENY', 'history-restore-board-write-only', 'FORBIDDEN'],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    accountApiKeyAuthorizationCase(
      `APIKEY-COMPOUND-${axis}`,
      preconditionState,
      expectedCodeOrState,
      'complete-operation-plan-before-network',
    ),
  );
  [
    ['RENAME-OWNER-ALLOW', 'rename-owner-with-board-write', 'BOARD_RENAMED'],
    ['RENAME-NONOWNER-DENY', 'rename-non-owner-with-board-write', 'FORBIDDEN'],
    ['CREATE-OWNER-ALLOW', 'create-owner-with-board-create', 'BOARD_CREATED'],
    ['CREATE-MISSING-SCOPE-DENY', 'create-owner-without-board-create', 'FORBIDDEN'],
    ['ARCHIVE-OWNER-ALLOW', 'archive-owner-with-board-archive', 'BOARD_ARCHIVED'],
    ['ARCHIVE-NONOWNER-DENY', 'archive-non-owner-with-board-archive', 'FORBIDDEN'],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    accountApiKeyAuthorizationCase(
      `APIKEY-LIFECYCLE-${axis}`,
      preconditionState,
      expectedCodeOrState,
      'literal-scope-owner-before-lifecycle-effect',
    ),
  );

  [
    ['PREFLIGHT-UNAVAILABLE', 'local-helper-unavailable', 'NO_NETWORK_CALL'],
    ['CURRENT-ALLOW', 'current-board-export-with-export-read', 'EXPORT_STREAMED'],
    ['HISTORICAL-ALLOW', 'retained-revision-export-with-export-read', 'EXPORT_STREAMED'],
    ['ADMISSION-DENY', 'account-board-credential-admission-limit', 'RATE_LIMITED_NO_RESERVATION'],
    ['RENDER-FAILURE', 'render-fails-after-reservation', 'RESERVATION_RELEASED'],
    ['COMPLETE', 'response-delivery-completes', 'ONE_COMPLETED_AUDIT_AND_RELEASE'],
    ['ABORT', 'response-delivery-aborts', 'ONE_FAILED_AUDIT_AND_RELEASE'],
    ['NO-CLOBBER', 'local-final-already-exists', 'LOCAL_EXPORT_EXISTS_PRESERVED'],
  ].forEach(([axis, preconditionState, expectedCodeOrState]) =>
    add({
      caseId: `APIKEY-EXPORT-${axis}`,
      cluster: 'ACCOUNT_API_KEY_EXPORT',
      owner: 'D2',
      testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      preconditionState,
      expectedCodeOrState,
      principalKind: 'account-api-key',
      upstreamContractId: 'D2-ACCOUNT-API-KEY-EXPORT-V1',
      precedence: 'preflight-authorization-admission-render-delivery-cleanup',
    }),
  );

  for (const tool of toolRegistries.general)
    for (const axis of ['VALID', 'MALFORMED', 'DENIED', 'REACHABLE_SAFE_ERROR'])
      add({
        caseId: `MCP-${tag(tool)}-${axis}`,
        cluster: 'MCP',
        owner: 'D6',
        testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
        preconditionState: `${tool}-${axis.toLowerCase()}`,
        expectedCodeOrState: axis === 'VALID' ? 'TOOL_RESULT_VALID' : axis,
        principalKind: 'mcp-client',
        upstreamContractId: `D6-TOOL-${tool}`,
        precedence: 'input-authz-owner-safe-error',
      });
  toolRegistries.generalDiscoveryCuts.forEach((count) =>
    add({
      caseId: `MCP-DISCOVERY-${String(count).padStart(2, '0')}`,
      cluster: 'MCP',
      owner: 'D6',
      testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
      preconditionState: `publication-cut-${count}`,
      expectedCodeOrState: `EXACT_${count}_TOOLS`,
      principalKind: 'mcp-client',
      upstreamContractId: 'D6-TOOL-DISCOVERY-V1',
    }),
  );
  for (const tool of toolRegistries.accountApiKey)
    for (const axis of ['VALID', 'MALFORMED', 'DENIED', 'REACHABLE_SAFE_ERROR'])
      add({
        caseId: `APIKEY-MCP-${tag(tool)}-${axis}`,
        cluster: 'MCP_ACCOUNT_API_KEY',
        owner: 'D6',
        testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
        preconditionState: `${tool}-account-api-key-${axis.toLowerCase()}`,
        expectedCodeOrState: axis === 'VALID' ? 'TOOL_RESULT_VALID' : axis,
        principalKind: 'account-api-key',
        upstreamContractId: `D6-ACCOUNT-API-KEY-TOOL-${tool}`,
        precedence: 'credential-mode-literal-scope-input-owner-safe-error',
      });
  add({
    caseId: 'APIKEY-MCP-DISCOVERY-22',
    cluster: 'MCP_ACCOUNT_API_KEY',
    owner: 'D6',
    testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
    preconditionState: 'account-api-key-publication-cut-22',
    expectedCodeOrState: 'EXACT_22_TOOLS',
    principalKind: 'account-api-key',
    upstreamContractId: 'D6-ACCOUNT-API-KEY-TOOL-DISCOVERY-V1',
  });

  [
    'maxBoardArtifacts',
    'maxBoardArtifactVersions',
    'maxBoardArtifactResourceRows',
    'maxBoardArtifactChargedBytes',
  ].forEach((limit) =>
    ['AT_LIMIT', 'ONE_OVER'].forEach((axis) =>
      add({
        caseId: `ARTIFACT-QUOTA-${tag(limit)}-${axis}`,
        cluster: 'ARTIFACT_QUOTA',
        owner: 'D7',
        testFile: 'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
        preconditionState: `${limit}-${axis}`,
        expectedCodeOrState: axis === 'AT_LIMIT' ? 'ALLOWED_AT_LIMIT' : 'LIMIT_EXCEEDED',
        principalKind: 'authorized-principal',
        upstreamContractId: `D1-LIMIT-${limit}`,
      }),
    ),
  );
  ['network.fetch', 'clipboard.write', 'download', 'fullscreen'].forEach((capability) => {
    ['ABSENT_DEFAULT_DENY', 'APPROVED_CURRENT_EPOCH', 'APPROVED_STALE_EPOCH', 'REVOKED'].forEach(
      (state) =>
        add({
          caseId: `ARTIFACT-POLICY-${tag(capability)}-${state}`,
          cluster: 'ARTIFACT_POLICY',
          owner: 'D7',
          testFile: 'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
          preconditionState: `${capability}-${state}`,
          expectedCodeOrState:
            state === 'APPROVED_CURRENT_EPOCH' ? 'CAPABILITY_ALLOWED' : 'CAPABILITY_DENIED',
          principalKind: 'artifact-runner',
          upstreamContractId: `D1-D2-D7-CAPABILITY-${capability}`,
        }),
    );
  });
  [
    'RUNNER-ZERO-COOKIE',
    'ASSET-ZERO-COOKIE',
    'OPAQUE-ORIGIN',
    'NO-PARENT-DOM',
    'NO-STORAGE',
    'NO-TOP-NAVIGATION',
    'CSP-SCRIPT',
    'CSP-CONNECT',
    'BRIDGE-REPLAY',
    'BRIDGE-SOURCE-ORIGIN',
    'HOSTILE-INFINITE-LOOP',
    'TRUSTED-FALLBACK',
  ].forEach((axis) =>
    add({
      caseId: `ARTIFACT-HOSTILE-${axis}`,
      cluster: 'ARTIFACT_HOSTILE',
      owner: 'D7',
      testFile: 'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
      preconditionState: axis,
      expectedCodeOrState: 'ISOLATED_OR_RECOVERED',
      principalKind: 'artifact-runner',
      upstreamContractId: 'D7-SANDBOX-BRIDGE-V1',
    }),
  );

  for (const kind of ['INFO', 'CHOICE', 'FORM', 'CONFIRMATION'])
    for (const state of ['OPEN', 'ANSWERED', 'SUPERSEDED', 'EXPIRED', 'CANCELLED'])
      add({
        caseId: `HITL-${kind}-${state}`,
        cluster: 'HITL_STATE',
        owner: 'D8',
        testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
        preconditionState: `${kind}-${state}`,
        expectedCodeOrState: state,
        principalKind: 'authorized-principal',
        upstreamContractId: 'D1-D8-HITL-WIRE-V1',
      });
  [2, 10, 100].forEach((contenders) =>
    add({
      caseId: `HITL-RACE-${String(contenders).padStart(2, '0')}`,
      cluster: 'HITL_RACE',
      owner: 'D8',
      testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      preconditionState: `${contenders}-contenders-20-repetitions`,
      expectedCodeOrState: 'ONE_TERMINAL_WINNER',
      principalKind: 'independently-authenticated-contenders',
      upstreamContractId: 'D8-HITL-TERMINAL-CAS-V1',
    }),
  );
  ['BEFORE', 'EQUAL', 'AFTER'].forEach((axis) =>
    add({
      caseId: `HITL-EXPIRY-${axis}`,
      cluster: 'HITL_EXPIRY',
      owner: 'D8',
      testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      preconditionState: `${axis}-createdAt-plus-15m`,
      expectedCodeOrState: axis === 'BEFORE' ? 'RESPONSE_ACCEPTABLE' : 'HITL_REQUEST_EXPIRED',
      principalKind: 'authorized-principal',
      upstreamContractId: 'D8-HITL-EXPIRY-V1',
    }),
  );
  ['ABSENT', 'FALSE', 'EXPIRED', 'CANCELLED', 'SUPERSEDED', 'RECONNECT-HISTORY'].forEach((axis) =>
    add({
      caseId: `HITL-DESTRUCTIVE-${axis}`,
      cluster: 'HITL_DESTRUCTIVE',
      owner: 'D8',
      testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      preconditionState: axis,
      expectedCodeOrState: 'NO_DESTRUCTIVE_APPROVAL',
      principalKind: 'browser-user',
      upstreamContractId: 'D8-DESTRUCTIVE-NON-APPROVAL-V1',
    }),
  );
  ['LIVE-UPDATE', 'RECONNECT-REPLAY', 'PINNED-HISTORY', 'RETURN-TO-LATEST'].forEach((axis) =>
    add({
      caseId: `HITL-LIVE-HISTORY-${axis}`,
      cluster: 'HITL_LIVE_HISTORY',
      owner: 'D8',
      testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      preconditionState: axis,
      expectedCodeOrState: 'AUTHORITATIVE_STATE_ONLY',
      principalKind: 'browser-user',
      upstreamContractId: 'D4-D5-D8-HITL-LIVE-HISTORY-V1',
    }),
  );
  ['STATUS', 'PROGRESS'].forEach((axis) =>
    add({
      caseId: `SCENE-NONINTERACTIVE-${axis}`,
      cluster: 'SCENE_NONINTERACTIVE',
      owner: 'D1',
      testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      preconditionState: `content.${axis.toLowerCase()}`,
      expectedCodeOrState: 'NO_HITL_RESPONSE_CONTROL',
      principalKind: 'browser-user',
      upstreamContractId: 'D1-CONTENT-NONINTERACTIVE-V1',
    }),
  );

  const carriers = new Map([
    ['HTTP_JSON_BODY', 'maxEnvelopeBytes'],
    ['MCP_JSONRPC_FRAME', 'maxEnvelopeBytes'],
    ['SSE_FRAME', 'maxEnvelopeBytes'],
    ['SSE_EVENT_DATA', 'maxEnvelopeBytes'],
    ['ARTIFACT_SOURCE_BODY', 'maxArtifactResourceBytes'],
    ['ARTIFACT_RESOURCE', 'maxArtifactResourceBytes'],
    ['ARTIFACT_TOTAL', 'maxArtifactTotalBytes'],
    ['ARTIFACT_BRIDGE_CONTROL', 'maxEnvelopeBytes'],
    ['HITL_DEFINITION', 'maxEnvelopeBytes'],
    ['HITL_RESPONSE', 'maxHitlResponseBytes'],
  ]);
  for (const [carrier, limit] of carriers)
    for (const axis of ['AT_LIMIT', 'ONE_OVER'])
      add({
        caseId: `CARRIER-${carrier}-${axis}`,
        cluster: 'CARRIER_BOUNDARY',
        owner: 'D1',
        testFile: 'test/security/hostile-payload-corpus.e2e.test.mjs',
        preconditionState: `${carrier}-${limit}-${axis}`,
        expectedCodeOrState:
          axis === 'AT_LIMIT' ? 'CARRIER_ACCEPTED' : 'PAYLOAD_TOO_LARGE_BEFORE_EFFECTS',
        principalKind: 'carrier-client',
        upstreamContractId: `D1-LIMIT-${limit}`,
      });

  const corpus = inventory.entries.find(({ id }) => id === 'D1-CORPUS').resources.slice(1);
  for (const resource of corpus)
    add({
      caseId: `SCHEMA-${resource.resourceId}`,
      cluster: 'SCHEMA_CORPUS',
      owner: 'D1',
      testFile: 'test/security/hostile-payload-corpus.e2e.test.mjs',
      preconditionState: resource.path,
      expectedCodeOrState: resource.path.includes('/invalid/')
        ? 'EXPECTED_SCHEMA_REJECTION'
        : 'EXPECTED_SCHEMA_ACCEPTANCE_OR_SCENARIO',
      principalKind: 'schema-fixture',
      upstreamContractId: 'D1-FROZEN-CORPUS-V1',
      upstreamFixtureId: resource.path,
      upstreamFixtureSha256: resourceHash.get(resource.path),
    });

  const secretClasses = [
    'ACCOUNT_PASSWORD',
    'SESSION_TOKEN',
    'SESSION_COOKIE_HEADER',
    'CSRF_TOKEN',
    'PAIRING_CODE',
    'PAIRING_PROOF',
    'MCP_GRANT_ACCESS_TOKEN',
    'ACCOUNT_API_KEY_TOKEN',
    'AUTHORIZATION_HEADER',
    'ARTIFACT_CAPABILITY_TICKET',
    'MYSQL_PASSWORD',
    'REDIS_PASSWORD',
    'MCP_OR_ENV_CONFIG_SECRET',
  ];
  const sinks = [
    'APPLICATION_LOG',
    'METRIC',
    'ERROR',
    'AUDIT',
    'MCP_STDOUT_OR_TOOL_CONTENT',
    'MCP_STDERR_OR_DIAGNOSTIC',
    'HTTP_RESPONSE_OR_URL',
    'DOM',
    'BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER',
    'SCREENSHOT_TRACE_OR_VIDEO',
    'RETRY_QUEUE_OR_OUTBOX',
    'CERTIFICATION_RECORD_OR_ATTACHMENT',
  ];
  const allowances = new Map([
    ['ACCOUNT_PASSWORD', ['signup-login-request-body']],
    ['SESSION_TOKEN', ['approved-session-cookie-set-cookie']],
    ['SESSION_COOKIE_HEADER', ['approved-session-cookie-header']],
    ['CSRF_TOKEN', ['approved-csrf-cookie-and-header']],
    ['PAIRING_CODE', ['owner-ui-and-claim-body']],
    ['PAIRING_PROOF', ['pairing-proof-authorization-only']],
    ['MCP_GRANT_ACCESS_TOKEN', ['redeem-rotate-response-and-bearer-input']],
    ['ACCOUNT_API_KEY_TOKEN', ['account-api-key-bearer-input']],
    ['AUTHORIZATION_HEADER', ['approved-inbound-auth-header']],
    ['ARTIFACT_CAPABILITY_TICKET', ['prepare-consume-transport']],
    ['MYSQL_PASSWORD', ['owner-process-input']],
    ['REDIS_PASSWORD', ['owner-process-input']],
    ['MCP_OR_ENV_CONFIG_SECRET', ['owner-process-input-or-file-read']],
  ]);
  for (const secretClass of secretClasses)
    for (const sink of sinks)
      add({
        caseId: `CANARY-${secretClass}-${sink}`,
        cluster: 'SECRET_CANARY',
        owner: 'D9',
        testFile: 'test/security/secret-canary.e2e.test.mjs',
        preconditionState: `${secretClass}-scanned-in-${sink}`,
        expectedCodeOrState: 'ZERO_UNAPPROVED_OCCURRENCES',
        principalKind: 'secret-canary',
        upstreamContractId: 'D2-D6-D7-D8-SECRET-TRANSPORT-V1',
        transportOnlyCanaryAllowance: allowances.get(secretClass),
      });

  return { schemaVersion: 1, sourceContractManifestSha256: manifestSha256, cases };
};

export const validateSecurityCatalog = async (catalog) => {
  assertExactKeys(
    catalog,
    ['schemaVersion', 'sourceContractManifestSha256', 'cases'],
    'SECURITY_CASE_CATALOG_DRIFT',
  );
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cases))
    throw new CertificationError('SECURITY_CASE_CATALOG_DRIFT');
  const caseIds = new Set();
  const evidenceIds = new Set();
  for (const row of catalog.cases) {
    assertExactKeys(row, rowKeys, 'SECURITY_CASE_CATALOG_DRIFT');
    if (
      caseIds.has(row.caseId) ||
      evidenceIds.has(row.evidenceRowId) ||
      row.evidenceClass !== 'live-required' ||
      !Array.isArray(row.transportOnlyCanaryAllowance)
    )
      throw new CertificationError('SECURITY_CASE_CATALOG_DRIFT');
    caseIds.add(row.caseId);
    evidenceIds.add(row.evidenceRowId);
  }
  const expected = await buildExpectedSecurityCatalog();
  if (canonicalJson(catalog) !== canonicalJson(expected))
    throw new CertificationError('SECURITY_CASE_CATALOG_DRIFT');
  return {
    schemaVersion: 1,
    status: 'PASS',
    caseCount: catalog.cases.length,
    catalogSha256: sha256(`${canonicalJson(catalog)}\n`),
    liveEvidenceStatus: 'BLOCKED',
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    arguments_.some((argument) => !['--observe', '--write'].includes(argument))
  ) {
    throw new CertificationError('SECURITY_CASE_CATALOG_ARGUMENT_INVALID');
  }
  if (arguments_.includes('--observe')) {
    process.stdout.write(`${canonicalJson(await buildExpectedSecurityCatalog())}\n`);
  } else if (arguments_.includes('--write')) {
    const expected = await buildExpectedSecurityCatalog();
    const canonicalBytes = `${canonicalJson(expected)}\n`;
    await writeFile(catalogPath, canonicalBytes, { mode: 0o644 });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: 'UPDATED',
        caseCount: expected.cases.length,
        catalogSha256: sha256(canonicalBytes),
      })}\n`,
    );
  } else {
    const { value } = await readJson(catalogPath);
    process.stdout.write(`${JSON.stringify(await validateSecurityCatalog(value))}\n`);
  }
}
