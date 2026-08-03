import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  'producerId',
  'producerEntrypoint',
];
const tag = (value) =>
  value.replaceAll('.', '-').replaceAll('_', '-').replaceAll(':', '-').toUpperCase();

const securityProducerId = 'sceneboard-security-boundary-producer-v1';
const securityProducerKeyId = 'sceneboard-security-certification-v1';
const liveEvidenceTtlMs = 15 * 60 * 1_000;
const securityOwnerFiles = [
  'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
  'test/security/auth-session-pairing.e2e.test.mjs',
  'test/security/authorization-order-and-cross-board.e2e.test.mjs',
  'test/security/hitl-race-and-non-approval.e2e.test.mjs',
  'test/security/hostile-payload-corpus.e2e.test.mjs',
  'test/security/mcp-tool-registry.e2e.test.mjs',
  'test/security/secret-canary.e2e.test.mjs',
];
const securityImplementationAuthorityId = 'sceneboard-security-implementation-authority-v1';
const securityBoundaryAuthorityFile = 'scripts/lib/certification/security-boundary-producers.mjs';
const securityProducerEntries = Object.freeze({
  'test/security/auth-session-pairing.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.auth-session-pairing.v1',
    adapterEntrypoint: 'executeAuthBoundary',
  }),
  'test/security/authorization-order-and-cross-board.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.authorization-cross-board.v1',
    adapterEntrypoint: 'executeAuthorizationBoundary',
  }),
  'test/security/hitl-race-and-non-approval.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.hitl-race.v1',
    adapterEntrypoint: 'executeHitlBoundary',
  }),
  'test/security/secret-canary.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.secret-canary.v1',
    adapterEntrypoint: 'executeSecretBoundary',
  }),
  'test/security/artifact-sandbox-and-capability.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.artifact-boundary.v1',
    adapterEntrypoint: 'executeArtifactBoundary',
  }),
  'test/security/hostile-payload-corpus.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.hostile-payload.v1',
    adapterEntrypoint: 'executePayloadBoundary',
  }),
  'test/security/mcp-tool-registry.e2e.test.mjs': Object.freeze({
    producerId: 'sceneboard.security.mcp-registry.v1',
    adapterEntrypoint: 'executeMcpBoundary',
  }),
});
const securityImplementationEntries = Object.freeze({
  'test/security/auth-session-pairing.e2e.test.mjs:AUTH_SESSION': {
    entrypoint: 'executeAuthBoundary',
    sources: [
      'test/security/auth-session-pairing.e2e.test.mjs',
      'sceneboard-be/src/auth/session.service.ts',
      'sceneboard-be/src/common/guards/authentication.guard.ts',
      'sceneboard-be/src/common/guards/csrf.guard.ts',
      'sceneboard-be/src/common/guards/origin.guard.ts',
    ],
  },
  'test/security/auth-session-pairing.e2e.test.mjs:ACCOUNT_API_KEY_AUTHENTICATION': {
    entrypoint: 'executeAuthBoundary',
    sources: [
      'test/security/auth-session-pairing.e2e.test.mjs',
      'sceneboard-be/src/api-keys/account-api-key.service.ts',
      'sceneboard-be/src/api-keys/account-api-key-token.codec.ts',
    ],
  },
  'test/security/auth-session-pairing.e2e.test.mjs:PAIRING': {
    entrypoint: 'executeAuthBoundary',
    sources: [
      'test/security/auth-session-pairing.e2e.test.mjs',
      'sceneboard-be/src/pairing/pairing.service.ts',
      'sceneboard-be/src/grants/grant.service.ts',
    ],
  },
  'test/security/authorization-order-and-cross-board.e2e.test.mjs:AUTHORIZATION': {
    entrypoint: 'executeAuthorizationBoundary',
    sources: [
      'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      'sceneboard-be/src/grants/board-access-policy.service.ts',
      'sceneboard-be/src/grants/board-access.policy.ts',
    ],
  },
  'test/security/authorization-order-and-cross-board.e2e.test.mjs:ACCOUNT_API_KEY_AUTHORIZATION': {
    entrypoint: 'executeAuthorizationBoundary',
    sources: [
      'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      'sceneboard-be/src/api-keys/account-api-key-authorization.policy.ts',
      'sceneboard-be/src/grants/board-access-policy.service.ts',
    ],
  },
  'test/security/authorization-order-and-cross-board.e2e.test.mjs:ACCOUNT_API_KEY_EXPORT': {
    entrypoint: 'executeAuthorizationBoundary',
    sources: [
      'test/security/authorization-order-and-cross-board.e2e.test.mjs',
      'sceneboard-be/src/exports/export-admission.service.ts',
      'sceneboard-be/src/exports/export-authorization.policy.ts',
      'sceneboard-mcp/src/exports/local-export-file.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:HITL_STATE': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/persistence/interaction.repository.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:HITL_RACE': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/application/hitl-wait-coordinator.ts',
      'sceneboard-be/src/interactions/persistence/interaction.repository.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:HITL_EXPIRY': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/application/interaction-lifecycle.service.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:HITL_DESTRUCTIVE': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/application/interaction-command.service.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:HITL_LIVE_HISTORY': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/application/interaction-lifecycle.service.ts',
    ],
  },
  'test/security/hitl-race-and-non-approval.e2e.test.mjs:SCENE_NONINTERACTIVE': {
    entrypoint: 'executeHitlBoundary',
    sources: [
      'test/security/hitl-race-and-non-approval.e2e.test.mjs',
      'sceneboard-be/src/interactions/application/interaction-command.service.ts',
    ],
  },
  'test/security/secret-canary.e2e.test.mjs:SECRET_CANARY': {
    entrypoint: 'executeSecretBoundary',
    sources: [
      'test/security/secret-canary.e2e.test.mjs',
      'sceneboard-be/src/app.module.ts',
      'sceneboard-be/src/common/security/redact-secrets.ts',
      'sceneboard-be/src/common/security/secret-sink-observability.ts',
      'sceneboard-be/src/common/filters/http-error.filter.ts',
      'sceneboard-be/src/audit/audit-events.ts',
      'sceneboard-be/src/audit/audit.repository.ts',
      'sceneboard-be/src/audit/audit.module.ts',
      'sceneboard-be/src/events/board-event-outbox.repository.ts',
      'sceneboard-be/src/events/outbox-dispatcher.service.ts',
      'sceneboard-be/src/events/events.module.ts',
      'sceneboard-be/src/sse/board-stream-health.service.ts',
      'packages/artifact-runtime/src/policy/secret-sink-observability.ts',
      'packages/artifact-runtime/src/policy/csp.ts',
      'packages/artifact-runtime/src/server/headers.ts',
      'packages/artifact-runtime/src/runner/outer.ts',
      'packages/artifact-runtime/src/runner/inner-bootstrap.ts',
      'packages/artifact-runtime/src/bridge/endpoint.ts',
      'packages/board-ui/src/artifact/ArtifactHost.tsx',
      'packages/board-ui/src/artifact/use-artifact-bridge.ts',
      'sceneboard-mcp/src/diagnostics/redact-secrets.ts',
      'sceneboard-mcp/src/diagnostics/safe-logger.ts',
      'sceneboard-mcp/src/tools/tool-result.ts',
      'scripts/lib/certification/evidence-writer.mjs',
    ],
  },
  'test/security/artifact-sandbox-and-capability.e2e.test.mjs:ARTIFACT_QUOTA': {
    entrypoint: 'executeArtifactBoundary',
    sources: [
      'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
      'packages/artifact-runtime/src/bridge/rate-budget.ts',
      'packages/board-schema/src/limits.ts',
    ],
  },
  'test/security/artifact-sandbox-and-capability.e2e.test.mjs:ARTIFACT_POLICY': {
    entrypoint: 'executeArtifactBoundary',
    sources: [
      'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
      'packages/artifact-runtime/src/policy/capabilities.ts',
    ],
  },
  'test/security/artifact-sandbox-and-capability.e2e.test.mjs:ARTIFACT_HOSTILE': {
    entrypoint: 'executeArtifactBoundary',
    sources: [
      'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
      'packages/board-ui/src/artifact/ArtifactHost.tsx',
      'packages/board-ui/src/artifact/use-artifact-bridge.ts',
      'packages/artifact-runtime/src/runner/outer.ts',
      'packages/artifact-runtime/src/runner/inner-bootstrap.ts',
      'packages/artifact-runtime/src/bridge/endpoint.ts',
      'packages/artifact-runtime/src/policy/csp.ts',
      'packages/artifact-runtime/src/server/headers.ts',
    ],
  },
  'test/security/hostile-payload-corpus.e2e.test.mjs:CARRIER_BOUNDARY': {
    entrypoint: 'executePayloadBoundary',
    sources: [
      'test/security/hostile-payload-corpus.e2e.test.mjs',
      'sceneboard-be/src/common/http/raw-body-profiles.ts',
    ],
  },
  'test/security/hostile-payload-corpus.e2e.test.mjs:SCHEMA_CORPUS': {
    entrypoint: 'executePayloadBoundary',
    sources: [
      'test/security/hostile-payload-corpus.e2e.test.mjs',
      'packages/board-schema/src/index.ts',
      'packages/board-schema/src/limits.ts',
    ],
  },
  'test/security/mcp-tool-registry.e2e.test.mjs:MCP': {
    entrypoint: 'executeMcpBoundary',
    sources: [
      'test/security/mcp-tool-registry.e2e.test.mjs',
      'sceneboard-mcp/src/tools/register-tools.ts',
      'sceneboard-mcp/src/tools/tool-result.ts',
    ],
  },
  'test/security/mcp-tool-registry.e2e.test.mjs:MCP_ACCOUNT_API_KEY': {
    entrypoint: 'executeMcpBoundary',
    sources: [
      'test/security/mcp-tool-registry.e2e.test.mjs',
      'sceneboard-mcp/src/tools/register-tools.ts',
      'sceneboard-mcp/src/tools/tool-result.ts',
    ],
  },
});

const securityImplementationIdentityCache = new Map();

export const securityImplementationIdentity = (definition) => {
  const cacheKey = `${definition.testFile}:${definition.cluster}`;
  const cached = securityImplementationIdentityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const descriptor = securityImplementationEntries[cacheKey];
  const producer = securityProducerEntries[definition.testFile];
  if (descriptor === undefined || producer === undefined)
    throw new CertificationError('SECURITY_LIVE_IMPLEMENTATION_IDENTITY_INVALID');
  if (descriptor.entrypoint !== producer.adapterEntrypoint)
    throw new CertificationError('SECURITY_LIVE_IMPLEMENTATION_IDENTITY_INVALID');
  const sourceFiles = [securityBoundaryAuthorityFile, ...descriptor.sources]
    .filter((path, index, values) => values.indexOf(path) === index)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
  const identity = {
    schemaVersion: 1,
    authorityId: securityImplementationAuthorityId,
    producerId: producer.producerId,
    executorId: producer.producerId,
    cluster: definition.cluster,
    entrypoint: 'executeSecurityBoundaryProducer',
    adapterEntrypoint: producer.adapterEntrypoint,
    sourceFiles,
  };
  const result = Object.freeze({
    ...identity,
    implementationSha256: sha256(canonicalJson(identity)),
  });
  securityImplementationIdentityCache.set(cacheKey, result);
  return result;
};

export const securityProducerDefinition = (definition) => {
  const identity = securityImplementationIdentity(definition);
  if (
    definition.producerId !== identity.producerId ||
    definition.producerEntrypoint !== identity.entrypoint
  )
    throw new CertificationError('SECURITY_LIVE_PRODUCER_MAPPING_INVALID');
  return Object.freeze({
    producerId: identity.producerId,
    testFile: definition.testFile,
    cluster: definition.cluster,
    adapterEntrypoint: identity.adapterEntrypoint,
    implementationIdentity: identity,
  });
};

export const validateSecurityProducerMappings = (catalog) => {
  const mappedFiles = Object.keys(securityProducerEntries).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const requiredFiles = [...securityOwnerFiles].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (
    canonicalJson(mappedFiles) !== canonicalJson(requiredFiles) ||
    new Set(Object.values(securityProducerEntries).map(({ producerId }) => producerId)).size !==
      mappedFiles.length ||
    !Array.isArray(catalog?.cases)
  )
    throw new CertificationError('SECURITY_LIVE_PRODUCER_MAPPING_INVALID');
  const routedFiles = new Set();
  for (const definition of catalog.cases) {
    const producer = securityProducerDefinition(definition);
    routedFiles.add(producer.testFile);
    if (
      producer.testFile !== definition.testFile ||
      producer.cluster !== definition.cluster ||
      !producer.implementationIdentity.sourceFiles.some(
        ({ path }) => path === securityBoundaryAuthorityFile,
      ) ||
      !producer.implementationIdentity.sourceFiles.some(({ path }) => !path.startsWith('test/'))
    )
      throw new CertificationError('SECURITY_LIVE_PRODUCER_MAPPING_INVALID');
  }
  if (canonicalJson([...routedFiles].sort()) !== canonicalJson(requiredFiles))
    throw new CertificationError('SECURITY_LIVE_PRODUCER_MAPPING_INVALID');
  return Object.freeze({ status: 'PASS', producerCount: mappedFiles.length });
};

const requireProducerKey = (value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32)
    throw new CertificationError('SECURITY_LIVE_PRODUCER_AUTHORITY_INVALID');
  return Buffer.from(value, 'utf8');
};

const canonicalBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');

const receiptPayloadKeys = [
  'schemaVersion',
  'executorId',
  'implementationIdentity',
  'implementationSha256',
  'identitySha256',
  'attemptId',
  'caseId',
  'observedCodeOrState',
  'status',
  'cleanupStatus',
  'operationTranscript',
  'operationSha256',
  'executionNonceSha256',
  'observedAt',
];

export const validateSecurityBoundaryReceipts = (
  catalog,
  identity,
  receipts,
  { executionNonce, now = Date.now() } = {},
) => {
  const nonce = requireProducerKey(executionNonce);
  if (!Array.isArray(receipts) || receipts.length !== catalog.cases.length)
    throw new CertificationError('SECURITY_LIVE_EXECUTION_RECEIPT_INVALID');
  const identitySha256 = sha256(canonicalJson(identity));
  return receipts.map((receipt, index) => {
    const definition = catalog.cases[index];
    const expectedImplementation = securityImplementationIdentity(definition);
    assertExactKeys(
      receipt,
      [...receiptPayloadKeys, 'authenticationSha256'],
      'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
    );
    const payload = Object.fromEntries(receiptPayloadKeys.map((key) => [key, receipt[key]]));
    const bytes = canonicalBytes(payload);
    const expectedAuthentication = createHmac('sha256', nonce).update(bytes).digest();
    const submittedAuthentication = Buffer.from(receipt.authenticationSha256, 'hex');
    const observedAt = Date.parse(receipt.observedAt);
    if (
      receipt.schemaVersion !== 2 ||
      receipt.executorId !== expectedImplementation.producerId ||
      canonicalJson(receipt.implementationIdentity) !== canonicalJson(expectedImplementation) ||
      receipt.implementationSha256 !== expectedImplementation.implementationSha256 ||
      receipt.identitySha256 !== identitySha256 ||
      receipt.attemptId !== identity.attemptId ||
      receipt.caseId !== definition.caseId ||
      receipt.observedCodeOrState !== definition.expectedCodeOrState ||
      receipt.status !== 'PASS' ||
      receipt.cleanupStatus !== 'PASS' ||
      !Array.isArray(receipt.operationTranscript) ||
      receipt.operationTranscript.length < 3 ||
      receipt.operationTranscript[0] !==
        `fixture-created:${identity.attemptId}:${definition.caseId}` ||
      receipt.operationTranscript.at(-1) !== 'cleanup-verified:zero-owned-residue' ||
      !receipt.operationTranscript.some((entry) => entry.startsWith('operation-executed:')) ||
      !receipt.operationTranscript.includes(`boundary-observed:${receipt.observedCodeOrState}`) ||
      receipt.operationSha256 !== sha256(canonicalJson(receipt.operationTranscript)) ||
      receipt.executionNonceSha256 !== sha256(nonce) ||
      !Number.isFinite(observedAt) ||
      observedAt > now ||
      observedAt < now - liveEvidenceTtlMs ||
      !/^[0-9a-f]{64}$/u.test(receipt.authenticationSha256) ||
      submittedAuthentication.length !== expectedAuthentication.length ||
      !timingSafeEqual(submittedAuthentication, expectedAuthentication)
    ) {
      throw new CertificationError('SECURITY_LIVE_EXECUTION_RECEIPT_INVALID');
    }
    return receipt;
  });
};

const createAuthenticatedLeaf = (definition, identity, receipt, producerKey, observedAt) => {
  const implementationIdentity = securityImplementationIdentity(definition);
  assertExactKeys(
    receipt,
    [...receiptPayloadKeys, 'authenticationSha256'],
    'SECURITY_LIVE_EVIDENCE_INVALID',
  );
  if (
    receipt.caseId !== definition.caseId ||
    receipt.observedCodeOrState !== definition.expectedCodeOrState ||
    receipt.status !== 'PASS' ||
    receipt.cleanupStatus !== 'PASS'
  ) {
    throw new CertificationError('SECURITY_LIVE_BOUNDARY_OBSERVATION_FAILED');
  }
  const payload = {
    schemaVersion: 2,
    producerId: securityProducerId,
    producerKeyId: securityProducerKeyId,
    identitySha256: sha256(canonicalJson(identity)),
    caseId: definition.caseId,
    evidenceRowId: definition.evidenceRowId,
    upstreamFixtureSha256: definition.upstreamFixtureSha256,
    executorSha256: sha256(implementationIdentity.executorId),
    implementationSha256: receipt.implementationSha256,
    executionReceiptSha256: sha256(canonicalJson(receipt)),
    operationSha256: receipt.operationSha256,
    operationCount: receipt.operationTranscript.length,
    observedCodeOrState: receipt.observedCodeOrState,
    status: receipt.status,
    cleanupStatus: receipt.cleanupStatus,
    observedAt,
  };
  const bytes = canonicalBytes(payload);
  return {
    payload,
    bytes,
    evidenceSha256: sha256(bytes),
    authenticationSha256: createHmac('sha256', producerKey).update(bytes).digest('hex'),
  };
};

export const produceSecurityLiveEvidence = (
  catalog,
  identity,
  receipts,
  { producerKey, executionNonce, now = Date.now() } = {},
) => {
  const key = requireProducerKey(producerKey);
  if (!Number.isFinite(now)) {
    throw new CertificationError('SECURITY_LIVE_EVIDENCE_INVALID');
  }
  const observations = validateSecurityBoundaryReceipts(catalog, identity, receipts, {
    executionNonce,
    now,
  });
  const producedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + liveEvidenceTtlMs).toISOString();
  const cases = catalog.cases.map((definition, index) => {
    const leaf = createAuthenticatedLeaf(
      definition,
      identity,
      observations[index],
      key,
      producedAt,
    );
    return {
      caseId: definition.caseId,
      evidenceRowId: definition.evidenceRowId,
      evidenceSha256: leaf.evidenceSha256,
      authenticationSha256: leaf.authenticationSha256,
      artifactBase64: leaf.bytes.toString('base64'),
    };
  });
  return {
    schemaVersion: 2,
    producer: {
      id: securityProducerId,
      keyId: securityProducerKeyId,
      producedAt,
      expiresAt,
    },
    catalogSha256: sha256(`${canonicalJson(catalog)}\n`),
    status: 'PASS',
    cleanupStatus: 'PASS',
    cases,
  };
};

export const collectSecurityBoundaryReceipts = async (catalog, identity, options = {}) => {
  validateSecurityProducerMappings(catalog);
  const executionNonce = randomBytes(32).toString('base64url');
  const directory = await mkdtemp(join(tmpdir(), 'sceneboard-security-boundary-'));
  try {
    const environment = {
      PATH: process.env.PATH,
      SCENEBOARD_SECURITY_RECEIPT_DIRECTORY: directory,
      SCENEBOARD_SECURITY_EXECUTION_NONCE: executionNonce,
      SCENEBOARD_CERTIFICATION_SOURCE_COMMIT: identity.sourceCommit,
      SCENEBOARD_CERTIFICATION_MANIFEST_SHA256: identity.manifestSha256,
      SCENEBOARD_CERTIFICATION_PROFILE: identity.profile,
      APP_ENV: identity.environment,
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: identity.attemptId,
      ...(options.faultOwner ? { SCENEBOARD_SECURITY_FAULT_OWNER: options.faultOwner } : {}),
    };
    const run = spawnSync(process.execPath, ['--test', ...securityOwnerFiles], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.status !== 0) throw new CertificationError('SECURITY_LIVE_BOUNDARY_EXECUTION_FAILED');
    const receipts = [];
    for (const ownerFile of securityOwnerFiles) {
      const bytes = await readFile(join(directory, `${sha256(ownerFile)}.json`));
      const value = JSON.parse(bytes.toString('utf8'));
      const expectedProducerId = securityProducerEntries[ownerFile]?.producerId;
      if (
        bytes.toString('utf8') !== `${canonicalJson(value)}\n` ||
        canonicalJson(Object.keys(value).sort()) !==
          canonicalJson(['producerId', 'receipts', 'schemaVersion']) ||
        value.schemaVersion !== 2 ||
        value.producerId !== expectedProducerId ||
        !Array.isArray(value.receipts) ||
        value.receipts.some(({ executorId }) => executorId !== expectedProducerId)
      )
        throw new CertificationError('SECURITY_LIVE_EXECUTION_RECEIPT_INVALID');
      receipts.push(...value.receipts);
    }
    const byCaseId = new Map(receipts.map((receipt) => [receipt.caseId, receipt]));
    if (byCaseId.size !== receipts.length)
      throw new CertificationError('SECURITY_LIVE_EXECUTION_RECEIPT_INVALID');
    const ordered = catalog.cases.map(({ caseId }) => byCaseId.get(caseId));
    validateSecurityBoundaryReceipts(catalog, identity, ordered, {
      executionNonce,
      now: Date.now(),
    });
    return { receipts: ordered, executionNonce };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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
      producerId: securityProducerEntries[testFile]?.producerId,
      producerEntrypoint: 'executeSecurityBoundaryProducer',
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
    accountApiKeyAuthorizationCase(`APIKEY-OWNER-${axis}`, preconditionState, expectedCodeOrState),
  );
  [
    ['SCENE-CURRENT-ALLOW', 'scene-current-board-read', 'AUTHORIZED_BOARD_READ'],
    ['SCENE-HISTORICAL-ALLOW', 'scene-revision-history-read', 'AUTHORIZED_HISTORY_READ'],
    ['SCENE-HISTORICAL-BOARD-ONLY-DENY', 'scene-revision-board-read-only', 'FORBIDDEN'],
    ['DOCUMENT-CURRENT-ALLOW', 'document-current-board-read', 'AUTHORIZED_BOARD_READ'],
    ['DOCUMENT-HISTORICAL-ALLOW', 'document-revision-history-read', 'AUTHORIZED_HISTORY_READ'],
    ['DOCUMENT-HISTORICAL-BOARD-ONLY-DENY', 'document-revision-board-read-only', 'FORBIDDEN'],
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
    ['DOCUMENT-REPLACE-ALLOW', 'document-replace-board-read-and-write', 'AUTHORIZED_COMPOUND_PLAN'],
    ['DOCUMENT-REPLACE-WRITE-ONLY-DENY', 'document-replace-board-write-only', 'FORBIDDEN'],
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

export const validateSecurityLiveEvidence = (
  catalog,
  evidence,
  identity,
  evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`),
  { producerKey, now = Date.now() } = {},
) => {
  const key = requireProducerKey(producerKey);
  assertExactKeys(
    evidence,
    ['schemaVersion', 'producer', 'catalogSha256', 'status', 'cleanupStatus', 'cases'],
    'SECURITY_LIVE_EVIDENCE_INVALID',
  );
  assertExactKeys(
    evidence.producer,
    ['id', 'keyId', 'producedAt', 'expiresAt'],
    'SECURITY_LIVE_EVIDENCE_INVALID',
  );
  const producedAt = Date.parse(evidence.producer.producedAt);
  const expiresAt = Date.parse(evidence.producer.expiresAt);
  if (
    evidence.schemaVersion !== 2 ||
    evidence.producer.id !== securityProducerId ||
    evidence.producer.keyId !== securityProducerKeyId ||
    !Number.isFinite(producedAt) ||
    !Number.isFinite(expiresAt) ||
    producedAt > now ||
    expiresAt <= now ||
    expiresAt - producedAt !== liveEvidenceTtlMs ||
    evidence.catalogSha256 !== sha256(`${canonicalJson(catalog)}\n`) ||
    evidence.status !== 'PASS' ||
    evidence.cleanupStatus !== 'PASS' ||
    !Buffer.isBuffer(evidenceBytes) ||
    evidenceBytes.toString('utf8') !== `${canonicalJson(evidence)}\n` ||
    !Array.isArray(evidence.cases) ||
    evidence.cases.length !== catalog.cases.length
  )
    throw new CertificationError('SECURITY_LIVE_EVIDENCE_INVALID');
  const identitySha256 = sha256(canonicalJson(identity));
  const leafArtifacts = [];
  const inventory = [];
  for (let index = 0; index < catalog.cases.length; index += 1) {
    const definition = catalog.cases[index];
    const implementationIdentity = securityImplementationIdentity(definition);
    const row = evidence.cases[index];
    assertExactKeys(
      row,
      ['caseId', 'evidenceRowId', 'evidenceSha256', 'authenticationSha256', 'artifactBase64'],
      'SECURITY_LIVE_EVIDENCE_INVALID',
    );
    let bytes;
    let payload;
    try {
      bytes = Buffer.from(row.artifactBase64, 'base64');
      if (bytes.toString('base64') !== row.artifactBase64) throw new Error('non-canonical base64');
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CertificationError('SECURITY_LIVE_EVIDENCE_INVALID');
    }
    assertExactKeys(
      payload,
      [
        'schemaVersion',
        'producerId',
        'producerKeyId',
        'identitySha256',
        'caseId',
        'evidenceRowId',
        'upstreamFixtureSha256',
        'executorSha256',
        'implementationSha256',
        'executionReceiptSha256',
        'operationSha256',
        'operationCount',
        'observedCodeOrState',
        'status',
        'cleanupStatus',
        'observedAt',
      ],
      'SECURITY_LIVE_EVIDENCE_INVALID',
    );
    const expectedAuthentication = createHmac('sha256', key).update(bytes).digest();
    const submittedAuthentication = Buffer.from(row.authenticationSha256, 'hex');
    if (
      row.caseId !== definition.caseId ||
      row.evidenceRowId !== definition.evidenceRowId ||
      row.evidenceSha256 !== sha256(bytes) ||
      !/^[0-9a-f]{64}$/u.test(row.authenticationSha256) ||
      submittedAuthentication.length !== expectedAuthentication.length ||
      !timingSafeEqual(submittedAuthentication, expectedAuthentication) ||
      bytes.toString('utf8') !== `${canonicalJson(payload)}\n` ||
      payload.schemaVersion !== 2 ||
      payload.producerId !== securityProducerId ||
      payload.producerKeyId !== securityProducerKeyId ||
      payload.identitySha256 !== identitySha256 ||
      payload.caseId !== definition.caseId ||
      payload.evidenceRowId !== definition.evidenceRowId ||
      payload.upstreamFixtureSha256 !== definition.upstreamFixtureSha256 ||
      payload.executorSha256 !== sha256(implementationIdentity.executorId) ||
      payload.implementationSha256 !== implementationIdentity.implementationSha256 ||
      !/^[0-9a-f]{64}$/u.test(payload.executionReceiptSha256) ||
      !/^[0-9a-f]{64}$/u.test(payload.operationSha256) ||
      !Number.isInteger(payload.operationCount) ||
      payload.operationCount < 3 ||
      payload.observedCodeOrState !== definition.expectedCodeOrState ||
      payload.status !== 'PASS' ||
      payload.cleanupStatus !== 'PASS' ||
      payload.observedAt !== evidence.producer.producedAt
    )
      throw new CertificationError('SECURITY_LIVE_EVIDENCE_INVALID');
    leafArtifacts.push(bytes);
    inventory.push({
      caseId: row.caseId,
      evidenceRowId: row.evidenceRowId,
      implementationSha256: payload.implementationSha256,
      evidenceSha256: row.evidenceSha256,
      authenticationSha256: row.authenticationSha256,
    });
  }
  const inventoryBytes = canonicalBytes({ schemaVersion: 2, cases: inventory });
  const details = {
    schemaVersion: 2,
    producerId: securityProducerId,
    producerKeyId: securityProducerKeyId,
    producedAt: evidence.producer.producedAt,
    expiresAt: evidence.producer.expiresAt,
    identitySha256,
    catalogSha256: evidence.catalogSha256,
    status: 'PASS',
    liveEvidenceStatus: 'PASS',
    cleanupStatus: 'PASS',
    caseCount: evidence.cases.length,
    caseSetSha256: sha256(
      canonicalJson(inventory.map(({ caseId, evidenceRowId }) => ({ caseId, evidenceRowId }))),
    ),
    evidenceSetSha256: sha256(evidenceBytes),
    leafInventorySha256: sha256(inventoryBytes),
    implementationSetSha256: sha256(
      canonicalJson(
        inventory.map(({ caseId, implementationSha256 }) => ({
          caseId,
          implementationSha256,
        })),
      ),
    ),
  };
  return {
    ...details,
    details,
    attachments: [
      ...leafArtifacts.map((bytes) => ({ bytes, mediaType: 'application/json' })),
      { bytes: inventoryBytes, mediaType: 'application/json' },
    ],
  };
};

export const validateSecurityLiveAttachmentInventory = (
  catalog,
  details,
  identity,
  inventoryBytes,
  leafBytesBySha256,
  options = {},
) => {
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString('utf8'));
  } catch {
    throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  }
  assertExactKeys(inventory, ['schemaVersion', 'cases'], 'SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  if (
    inventory.schemaVersion !== 2 ||
    inventoryBytes.toString('utf8') !== `${canonicalJson(inventory)}\n` ||
    sha256(inventoryBytes) !== details.leafInventorySha256 ||
    !Array.isArray(inventory.cases) ||
    inventory.cases.length !== catalog.cases.length
  ) {
    throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  }
  const cases = inventory.cases.map((row, index) => {
    assertExactKeys(
      row,
      ['caseId', 'evidenceRowId', 'implementationSha256', 'evidenceSha256', 'authenticationSha256'],
      'SECURITY_LIVE_ATTACHMENT_SET_INVALID',
    );
    const definition = catalog.cases[index];
    const bytes = leafBytesBySha256.get(row.evidenceSha256);
    if (
      row.caseId !== definition.caseId ||
      row.evidenceRowId !== definition.evidenceRowId ||
      row.implementationSha256 !==
        securityImplementationIdentity(definition).implementationSha256 ||
      !Buffer.isBuffer(bytes) ||
      sha256(bytes) !== row.evidenceSha256
    ) {
      throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
    }
    return { ...row, artifactBase64: bytes.toString('base64') };
  });
  const evidence = {
    schemaVersion: 2,
    producer: {
      id: details.producerId,
      keyId: details.producerKeyId,
      producedAt: details.producedAt,
      expiresAt: details.expiresAt,
    },
    catalogSha256: details.catalogSha256,
    status: details.status,
    cleanupStatus: details.cleanupStatus,
    cases,
  };
  const validated = validateSecurityLiveEvidence(
    catalog,
    evidence,
    identity,
    canonicalBytes(evidence),
    options,
  );
  if (canonicalJson(validated.details) !== canonicalJson(details))
    throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  return validated.details;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    arguments_.some((argument) => !['--observe', '--write', '--produce-live'].includes(argument))
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
  } else if (arguments_.includes('--produce-live')) {
    const identity = {
      sourceCommit: process.env.SCENEBOARD_CERTIFICATION_SOURCE_COMMIT,
      manifestSha256: process.env.SCENEBOARD_CERTIFICATION_MANIFEST_SHA256,
      profile: 'non-production',
      environment: process.env.APP_ENV,
      attemptId: process.env.SCENEBOARD_CERTIFICATION_ATTEMPT_ID,
    };
    if (
      !/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? '') ||
      !/^[0-9a-f]{64}$/u.test(identity.manifestSha256 ?? '') ||
      !['development', 'test', 'staging'].includes(identity.environment) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.attemptId ?? '')
    ) {
      throw new CertificationError('SECURITY_LIVE_TRUSTED_IDENTITY_MISSING');
    }
    const { value: catalog } = await readJson(catalogPath);
    await validateSecurityCatalog(catalog);
    const execution = await collectSecurityBoundaryReceipts(catalog, identity);
    process.stdout.write(
      `${canonicalJson(
        produceSecurityLiveEvidence(catalog, identity, execution.receipts, {
          producerKey: process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY,
          executionNonce: execution.executionNonce,
        }),
      )}\n`,
    );
  } else {
    const { value } = await readJson(catalogPath);
    process.stdout.write(`${JSON.stringify(await validateSecurityCatalog(value))}\n`);
  }
}
