import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';
import sharp from 'sharp';
import {
  AI_EXPORT_REQUIRED_ROWS,
  BROWSER_SCENARIO_IDS,
  validateBrowserEvidence,
  MANUAL_BROWSER_CASE_IDS,
  MANUAL_BROWSER_VIEWPORTS,
  manualEvidenceSha256,
  createBrowserCertificationEnvironment,
  createTraceabilityEvidence,
  validateManualReportBytes,
  produceAiExportCertification,
} from '../../scripts/certify-ai-export-contracts.mjs';
import { canonicalJson, sha256 } from '../../scripts/lib/certification/canonical-json.mjs';
import {
  parseCertificationArguments,
  runNamedCertificationPhase,
  runReleaseCertification,
} from '../../scripts/run-local-certification.mjs';
import {
  finalizeAiExportCertification,
  verifyAiExportCertification,
} from '../../scripts/verify-ai-export-certification.mjs';
import {
  buildServiceEnvironment,
  EXPORT_VISUAL_MARKERS,
  runCleanupActions,
  verifyRetainedExportArtifacts,
  waitForHttpReadiness,
} from '../../scripts/certify-export-browser-e2e.mjs';
import { verifyAuthOriginTopology } from '../../scripts/verify-auth-origin-topology.mjs';
import {
  CertificationProcessSupervisor,
  createCertificationChildEnvironment,
  createGitCertificationEnvironment,
  createNpmCertificationEnvironment,
} from '../../scripts/lib/certification/process-lifecycle.mjs';
import {
  collectSecurityBoundaryReceipts,
  produceSecurityLiveEvidence,
  securityImplementationIdentity,
  validateSecurityProducerMappings,
  validateSecurityLiveAttachmentInventory,
  validateSecurityLiveEvidence,
} from '../../scripts/lib/certification/security-catalog.mjs';
import * as securityCatalogModule from '../../scripts/lib/certification/security-catalog.mjs';
import {
  registerAuthenticatedBoundaryRows,
  securityRequiredOwners,
} from '../security/security-catalog.test-helper.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const securityCatalog = JSON.parse(
  await readFile(
    new URL('../certification/security-case-catalog.v1.json', import.meta.url),
    'utf8',
  ),
);

test('release accepts non-production only and cannot authorize deployment', () => {
  assert.deepEqual(parseCertificationArguments(['--phase=release', '--profile=non-production']), {
    phase: 'release',
    profile: 'non-production',
  });
  assert.throws(
    () => parseCertificationArguments(['--phase=release', '--profile=production']),
    (error) => error?.code === 'PRODUCTION_TARGET_FORBIDDEN',
  );
});

test('release closure requires live security, backup/restore, database, and workspace rows', async () => {
  const required = new Map(AI_EXPORT_REQUIRED_ROWS.map((row) => [row.id, row]));
  for (const rowId of [
    'CERT-SECURITY-LIVE',
    'CERT-BACKUP-RESTORE',
    'CERT-RESTORE-LIVE',
    'CERT-DATABASE-BOUNDARY',
    'CERT-WORKSPACE-BOUNDARY',
  ])
    assert.equal(required.has(rowId), true, rowId);
  assert.deepEqual(required.get('CERT-SECURITY-LIVE').requiredAssertions, [
    'exact-live-case-set',
    'every-live-case-pass',
    'exact-owned-fixture-clean',
  ]);
  assert.equal(
    (await runNamedCertificationPhase({ phase: 'security' }, {})).reason,
    'SECURITY_LIVE_EVIDENCE_MISSING',
  );
  assert.equal(
    (await runNamedCertificationPhase({ phase: 'restore' }, {})).reason,
    'RESTORE_LIVE_IDENTITY_MISSING',
  );
  assert.equal(
    (await runNamedCertificationPhase({ phase: 'database' }, { PATH: process.env.PATH })).status,
    'BLOCKED',
  );
  const mismatchedIdentity = await runNamedCertificationPhase(
    { phase: 'database' },
    {
      PATH: process.env.PATH,
      MYSQL_HOST: '127.0.0.1',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: '../unsafe-attempt',
    },
  );
  assert.equal(mismatchedIdentity.status, 'BLOCKED');
  assert.equal(mismatchedIdentity.reason, 'CERTIFICATION_ENVIRONMENT_UNSAFE');
  const unavailable = await runNamedCertificationPhase(
    { phase: 'database' },
    {
      PATH: process.env.PATH,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '1',
      MYSQL_USER: 'certification-fixture',
      MYSQL_PASSWORD: 'fixture-value',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: 'database-unavailable-attempt',
    },
  );
  assert.equal(unavailable.status, 'BLOCKED');
  assert.deepEqual(unavailable.scenarios, []);
});

test('security producer authority rejects caller-selected and test-only receipt identities', () => {
  const definition = securityCatalog.cases[0];
  const implementationIdentity = securityImplementationIdentity(definition);
  assert.equal('createSecurityBoundaryReceipt' in securityCatalogModule, false);
  assert.notEqual(implementationIdentity.producerId, definition.testFile);
  assert.equal(implementationIdentity.entrypoint, 'executeSecurityBoundaryProducer');
  assert.ok(
    implementationIdentity.sourceFiles.some(
      ({ path }) => path === 'scripts/lib/certification/security-boundary-producers.mjs',
    ),
  );
});

test('security producer mapping rejects unknown and mismatched case routing', () => {
  assert.equal(validateSecurityProducerMappings(securityCatalog).status, 'PASS');
  for (const mutation of [
    { producerId: 'test-only.fabricated-pass' },
    { producerEntrypoint: 'callerSelectedSubstitute' },
    { testFile: 'test/security/secret-canary.e2e.test.mjs' },
  ]) {
    const altered = structuredClone(securityCatalog);
    Object.assign(altered.cases[0], mutation);
    assert.throws(
      () => validateSecurityProducerMappings(altered),
      (error) =>
        error?.code === 'SECURITY_LIVE_PRODUCER_MAPPING_INVALID' ||
        error?.code === 'SECURITY_LIVE_IMPLEMENTATION_IDENTITY_INVALID',
    );
  }
});

test('current-source adapter substitution cannot mint live security or release PASS', async () => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'sceneboard-substituted-security-'));
  try {
    const run = spawnSync(
      process.execPath,
      ['--test', 'test/security/auth-session-pairing.e2e.test.mjs'],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          SCENEBOARD_SECURITY_RECEIPT_DIRECTORY: receiptDirectory,
          SCENEBOARD_SECURITY_EXECUTION_NONCE: 'same-identity-substitution-nonce-material-v1',
          SCENEBOARD_SECURITY_SUBSTITUTE_EFFECT: 'AUTH-N01',
          SCENEBOARD_CERTIFICATION_SOURCE_COMMIT: 'a'.repeat(40),
          SCENEBOARD_CERTIFICATION_MANIFEST_SHA256: 'b'.repeat(64),
          SCENEBOARD_CERTIFICATION_PROFILE: 'non-production',
          APP_ENV: 'test',
          SCENEBOARD_CERTIFICATION_ATTEMPT_ID: 'same-identity-substitution-attempt',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.notEqual(run.status, 0, 'a skipped represented effect must fail closed');
    assert.deepEqual(await readdir(receiptDirectory), []);
    assert.throws(
      () =>
        produceSecurityLiveEvidence(
          securityCatalog,
          {
            sourceCommit: 'a'.repeat(40),
            manifestSha256: 'b'.repeat(64),
            profile: 'non-production',
            environment: 'test',
            attemptId: 'same-identity-substitution-attempt',
          },
          [],
          {
            producerKey: 'same-identity-substitution-producer-key-material',
            executionNonce: 'same-identity-substitution-nonce-material-v1',
          },
        ),
      (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
    );
    assert.equal((await runNamedCertificationPhase({ phase: 'security' }, {})).status, 'BLOCKED');
  } finally {
    await rm(receiptDirectory, { recursive: true, force: true });
  }
});

test('live security evidence requires repository execution receipts and cleanup PASS', async () => {
  const identity = {
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    profile: 'non-production',
    environment: 'test',
    attemptId: 'security-live-attempt',
  };
  const producerKey = 'security-producer-test-key-material-32-bytes';
  const execution = await collectSecurityBoundaryReceipts(securityCatalog, identity);
  await assert.rejects(
    () =>
      registerAuthenticatedBoundaryRows({
        producerId: 'test-only.missing-producer',
        expectedCounts: {},
        adapter: function fabricatedTestOnlyPass() {},
        executeBoundary: function fabricatedTestOnlyBoundary() {},
      }),
    /unknown security producer/u,
  );
  const evidence = produceSecurityLiveEvidence(securityCatalog, identity, execution.receipts, {
    producerKey,
    executionNonce: execution.executionNonce,
  });
  const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`);
  assert.equal(
    validateSecurityLiveEvidence(securityCatalog, evidence, identity, evidenceBytes, {
      producerKey,
    }).status,
    'PASS',
  );
  const incomplete = structuredClone(evidence);
  incomplete.cases.shift();
  assert.throws(
    () =>
      validateSecurityLiveEvidence(
        securityCatalog,
        incomplete,
        identity,
        Buffer.from(`${canonicalJson(incomplete)}\n`),
        { producerKey },
      ),
    (error) => error?.code === 'SECURITY_LIVE_EVIDENCE_INVALID',
  );
  const formerCatalogMap = securityCatalog.cases.map((row) => ({
    caseId: row.caseId,
    observedCodeOrState: row.expectedCodeOrState,
    status: 'PASS',
    cleanupStatus: 'PASS',
  }));
  assert.throws(
    () =>
      produceSecurityLiveEvidence(securityCatalog, identity, formerCatalogMap, {
        producerKey,
        executionNonce: execution.executionNonce,
      }),
    (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
  );
  const mutatedDenial = structuredClone(execution.receipts);
  mutatedDenial.find(({ caseId }) => caseId === 'AUTH-N01').observedCodeOrState = 'SESSION_CURRENT';
  assert.throws(
    () =>
      produceSecurityLiveEvidence(securityCatalog, identity, mutatedDenial, {
        producerKey,
        executionNonce: execution.executionNonce,
      }),
    (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
  );
  const failedCleanup = structuredClone(execution.receipts);
  failedCleanup[0].cleanupStatus = 'BLOCKED';
  assert.throws(
    () =>
      produceSecurityLiveEvidence(securityCatalog, identity, failedCleanup, {
        producerKey,
        executionNonce: execution.executionNonce,
      }),
    (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
  );
  for (const invalidReceipts of [
    execution.receipts.slice(1),
    [...execution.receipts, execution.receipts[0]],
    [execution.receipts[1], execution.receipts[0], ...execution.receipts.slice(2)],
  ])
    assert.throws(
      () =>
        produceSecurityLiveEvidence(securityCatalog, identity, invalidReceipts, {
          producerKey,
          executionNonce: execution.executionNonce,
        }),
      (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
    );
  const firstReceipt = execution.receipts[0];
  const staleReceipt = structuredClone(firstReceipt);
  staleReceipt.observedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  const { authenticationSha256: _authenticationSha256, ...stalePayload } = staleReceipt;
  staleReceipt.authenticationSha256 = createHmac('sha256', execution.executionNonce)
    .update(Buffer.from(`${canonicalJson(stalePayload)}\n`, 'utf8'))
    .digest('hex');
  assert.throws(
    () =>
      produceSecurityLiveEvidence(
        securityCatalog,
        identity,
        [staleReceipt, ...execution.receipts.slice(1)],
        { producerKey, executionNonce: execution.executionNonce },
      ),
    (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
  );
  const fabricated = structuredClone(evidence);
  fabricated.cases[0].artifactBase64 = Buffer.from(
    `${canonicalJson({ fabricated: 'PASS' })}\n`,
  ).toString('base64');
  assert.throws(
    () =>
      validateSecurityLiveEvidence(
        securityCatalog,
        fabricated,
        identity,
        Buffer.from(`${canonicalJson(fabricated)}\n`),
        { producerKey },
      ),
    (error) => error?.code === 'SECURITY_LIVE_EVIDENCE_INVALID',
  );

  const assertSemanticMutationRejected = (
    caseId,
    mutation,
    expectedAttachmentErrorCode = 'SECURITY_LIVE_EVIDENCE_INVALID',
  ) => {
    const altered = structuredClone(evidence);
    const row = altered.cases.find((candidate) => candidate.caseId === caseId);
    const payload = JSON.parse(Buffer.from(row.artifactBase64, 'base64').toString('utf8'));
    Object.assign(payload, mutation);
    const bytes = Buffer.from(`${canonicalJson(payload)}\n`);
    row.artifactBase64 = bytes.toString('base64');
    row.evidenceSha256 = sha256(bytes);
    row.authenticationSha256 = createHmac('sha256', producerKey).update(bytes).digest('hex');
    const alteredBytes = Buffer.from(`${canonicalJson(altered)}\n`);
    assert.throws(
      () =>
        validateSecurityLiveEvidence(securityCatalog, altered, identity, alteredBytes, {
          producerKey,
        }),
      (error) => error?.code === 'SECURITY_LIVE_EVIDENCE_INVALID',
    );
    const inventory = {
      schemaVersion: 2,
      cases: altered.cases.map(
        ({ caseId: id, evidenceRowId, evidenceSha256, authenticationSha256, artifactBase64 }) => ({
          caseId: id,
          evidenceRowId,
          implementationSha256: JSON.parse(Buffer.from(artifactBase64, 'base64').toString('utf8'))
            .implementationSha256,
          evidenceSha256,
          authenticationSha256,
        }),
      ),
    };
    const inventoryBytes = Buffer.from(`${canonicalJson(inventory)}\n`);
    const leafBytes = new Map(
      altered.cases.map((candidate) => [
        candidate.evidenceSha256,
        Buffer.from(candidate.artifactBase64, 'base64'),
      ]),
    );
    assert.throws(
      () =>
        validateSecurityLiveAttachmentInventory(
          securityCatalog,
          {
            ...validateSecurityLiveEvidence(securityCatalog, evidence, identity, evidenceBytes, {
              producerKey,
            }).details,
            evidenceSetSha256: sha256(alteredBytes),
            leafInventorySha256: sha256(inventoryBytes),
          },
          identity,
          inventoryBytes,
          leafBytes,
          { producerKey },
        ),
      (error) => error?.code === expectedAttachmentErrorCode,
    );
  };
  assertSemanticMutationRejected('AUTH-N01', { observedCodeOrState: 'SESSION_CURRENT' });
  assertSemanticMutationRejected(securityCatalog.cases[0].caseId, { cleanupStatus: 'BLOCKED' });
  assertSemanticMutationRejected(
    securityCatalog.cases[0].caseId,
    { implementationSha256: '0'.repeat(64) },
    'SECURITY_LIVE_ATTACHMENT_SET_INVALID',
  );
  assert.throws(
    () =>
      validateSecurityLiveEvidence(
        securityCatalog,
        evidence,
        { ...identity, attemptId: 'cross-attempt' },
        evidenceBytes,
        { producerKey },
      ),
    (error) => error?.code === 'SECURITY_LIVE_EVIDENCE_INVALID',
  );
  assert.throws(
    () =>
      validateSecurityLiveEvidence(securityCatalog, evidence, identity, evidenceBytes, {
        producerKey: 'different-security-producer-key-material',
      }),
    (error) => error?.code === 'SECURITY_LIVE_EVIDENCE_INVALID',
  );
});

test('every security owner cluster fault blocks every release evidence layer', async () => {
  const identity = {
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    profile: 'non-production',
    environment: 'test',
    attemptId: 'security-owner-negative-attempt',
  };
  const producerKey = 'security-owner-negative-producer-key-material';
  const owners = securityRequiredOwners(securityCatalog.cases);
  for (const faultOwner of owners) {
    const receipts = [];
    await assert.rejects(
      async () => {
        const execution = await collectSecurityBoundaryReceipts(securityCatalog, identity, {
          faultOwner,
        });
        receipts.push(...execution.receipts);
      },
      (error) => error?.code === 'SECURITY_LIVE_BOUNDARY_EXECUTION_FAILED',
    );
    assert.equal(receipts.length, 0, `${faultOwner} created receipts after its owner fault`);
    assert.throws(
      () =>
        produceSecurityLiveEvidence(securityCatalog, identity, receipts, {
          producerKey,
          executionNonce: 'security-owner-negative-execution-nonce-material',
        }),
      (error) => error?.code === 'SECURITY_LIVE_EXECUTION_RECEIPT_INVALID',
    );
    assert.throws(
      () =>
        validateSecurityLiveAttachmentInventory(
          securityCatalog,
          {
            leafInventorySha256: sha256(
              Buffer.from(`${canonicalJson({ schemaVersion: 2, cases: [] })}\n`),
            ),
          },
          identity,
          Buffer.from(`${canonicalJson({ schemaVersion: 2, cases: [] })}\n`),
          new Map(),
          { producerKey },
        ),
      (error) => error?.code === 'SECURITY_LIVE_ATTACHMENT_SET_INVALID',
    );
    assert.equal((await runNamedCertificationPhase({ phase: 'security' }, {})).status, 'BLOCKED');
    await assert.rejects(
      () =>
        runReleaseCertification(
          { phase: 'release', profile: 'non-production' },
          {
            preflight: async () => ({
              source: { certificationSourceCommit: identity.sourceCommit },
            }),
            produce: async () =>
              collectSecurityBoundaryReceipts(securityCatalog, identity, { faultOwner }),
            finalize: async () => ({ rollup: { status: 'PASS' } }),
            environment: 'test',
          },
        ),
      (error) => error?.code === 'SECURITY_LIVE_BOUNDARY_EXECUTION_FAILED',
    );
  }
});

test('release runner reaches the immutable I-53 producer and verifier', async () => {
  const calls = [];
  const produced = { marker: 'produced' };
  const result = await runReleaseCertification(
    { phase: 'release', profile: 'non-production' },
    {
      preflight: async () => ({ source: { certificationSourceCommit: 'a'.repeat(40) } }),
      produce: async (input) => {
        calls.push(['produce', input.sourceCommit, input.profile]);
        return produced;
      },
      finalize: async (input) => {
        calls.push(['finalize', input.marker]);
        return { rollup: { status: 'PASS' } };
      },
      environment: 'test',
    },
  );
  assert.equal(result.rollup.status, 'PASS');
  assert.deepEqual(calls, [
    ['produce', 'a'.repeat(40), 'non-production'],
    ['finalize', 'produced'],
  ]);
});

test('release evidence is one canonical immutable attempt with a closed semantic row set', async (context) => {
  const workspaceRoot = join(tmpdir(), `sceneboard-i53-release-${process.pid}`);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  context.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sourceCommit = 'a'.repeat(40);
  const securityProducerKey = 'release-security-producer-key-material-32-bytes';
  const previousSecurityProducerKey = process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY;
  process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY = securityProducerKey;
  context.after(() => {
    if (previousSecurityProducerKey === undefined)
      delete process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY;
    else process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY = previousSecurityProducerKey;
  });
  const executeRow = async (row, identity) => {
    let details = {};
    let attachments;
    if (row.id === 'INT-AUTH-ORIGINS') {
      const generatedAt = new Date(Date.now() - 1_000);
      const topology = {
        identity,
        frontendOrigin: 'http://127.0.0.1:3410',
        apiOrigin: 'http://127.0.0.1:3411',
        runtimeOrigin: 'http://127.0.0.2:3412',
        frontendInputSha256: 'b'.repeat(64),
        backendInputSha256: 'c'.repeat(64),
        runtimeInputSha256: 'd'.repeat(64),
      };
      details = {
        schemaVersion: 'auth-artifact-origin-evidence/v3',
        generatedAt: generatedAt.toISOString(),
        expiresAt: new Date(generatedAt.getTime() + 10 * 60_000).toISOString(),
        frontendOrigin: 'http://127.0.0.1:3410',
        apiOrigin: 'http://127.0.0.1:3411',
        runtimeOrigin: 'http://127.0.0.2:3412',
        appEnv: identity.environment,
        frontendInputSha256: 'b'.repeat(64),
        backendInputSha256: 'c'.repeat(64),
        runtimeInputSha256: 'd'.repeat(64),
        identity,
        target: {
          kind: 'submitted-deployment-topology',
          bindingSha256: sha256(canonicalJson(topology)),
        },
      };
    } else if (row.id === 'CERT-BROWSER-E2E') {
      details = {
        schemaVersion: 1,
        status: 'PASS',
        scenarios: BROWSER_SCENARIO_IDS.map((id) => ({
          id,
          status: 'PASS',
          evidenceSha256: sha256(id),
        })),
        payloadDigests: { before: 'e'.repeat(64), after: 'e'.repeat(64) },
        artifactSemantics: {
          schemaVersion: 1,
          revision: 'retained',
          expectedMarkerIds: ['retained-alpha', 'retained-beta'],
          pdfMarkerIds: ['retained-alpha', 'retained-beta'],
          pptxMarkerIds: ['retained-alpha', 'retained-beta'],
          absentHeadMarkerIds: ['head-alpha', 'head-beta'],
          pdfArtifactSha256: '8'.repeat(64),
          pptxArtifactSha256: '9'.repeat(64),
        },
        targetTopology: {
          kind: 'isolated-loopback-browser-fixture',
          attemptId: identity.attemptId,
          databaseOwnerSha256: '7'.repeat(64),
          frontendOrigin: 'http://127.0.0.1:45001',
          apiOrigin: 'http://127.0.0.1:45002',
          runtimeOrigin: 'http://127.0.0.1:45003',
        },
        cleanupStatus: 'PASS',
      };
      validateBrowserEvidence(details);
    } else if (row.id === 'CERT-SECRET-SCAN') {
      details = { violations: [], trackedCount: 1, indexCount: 1, headCount: 1 };
    } else if (row.id === 'CERT-SECURITY-LIVE') {
      const execution = await collectSecurityBoundaryReceipts(securityCatalog, identity);
      const evidence = produceSecurityLiveEvidence(securityCatalog, identity, execution.receipts, {
        producerKey: securityProducerKey,
        executionNonce: execution.executionNonce,
      });
      const validated = validateSecurityLiveEvidence(
        securityCatalog,
        evidence,
        identity,
        Buffer.from(`${canonicalJson(evidence)}\n`),
        { producerKey: securityProducerKey },
      );
      details = validated.details;
      attachments = validated.attachments;
    } else if (row.id === 'CERT-RESTORE-LIVE') {
      const certifiedAt = new Date();
      const evidence = {
        schemaVersion: 2,
        attemptId: identity.attemptId,
        deploymentId: `cert-${sha256(identity.attemptId).slice(0, 24)}`,
        attemptSeq: 1,
        sourceSchemaSha256: sha256(
          `sceneboard_cert_${sha256(`${identity.attemptId}.restore.source`).slice(0, 20)}`,
        ),
        sourceOwnerSha256: sha256(`sceneboard-certification-restore:${identity.attemptId}:source`),
        quarantineSchemaSha256: sha256(
          `sceneboard_cert_${sha256(`${identity.attemptId}.restore.quarantine`).slice(0, 20)}`,
        ),
        quarantineOwnerSha256: sha256(
          `sceneboard-certification-restore:${identity.attemptId}:quarantine`,
        ),
        operatorPrincipalSha256: '1'.repeat(64),
        startedAt: new Date(certifiedAt.getTime() - 2_000).toISOString(),
        restoredAt: new Date(certifiedAt.getTime() - 1_000).toISOString(),
        certifiedAt: certifiedAt.toISOString(),
        expiresAt: new Date(certifiedAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        sourceBackupSha256: '2'.repeat(64),
        registrySha256: '6'.repeat(64),
        mediaManifestSha256: '3'.repeat(64),
        schemaProjectionSha256: '4'.repeat(64),
        integritySha256: '5'.repeat(64),
        cleanupStatus: 'PASS',
      };
      details = {
        ...evidence,
        evidenceSha256: sha256(canonicalJson(evidence)),
        status: 'PASS',
      };
    } else if (row.id === 'CERT-TRACEABILITY') {
      details = createTraceabilityEvidence(identity);
    } else if (row.id === 'MANUAL-BROWSER-ACCEPTANCE') {
      const observedAt = new Date().toISOString();
      const cases = MANUAL_BROWSER_CASE_IDS.map((caseId) => {
        const content = `${caseId} sanitized supervised observation`;
        const evidence = { content, contentSha256: sha256(content), attachments: [] };
        const value = {
          caseId,
          status: 'PASS',
          provenance: {
            attemptId: identity.attemptId,
            sourceCommit: identity.sourceCommit,
            manifestSha256: identity.manifestSha256,
            observedAt,
            browserBuildSha256: 'f'.repeat(64),
          },
          viewport: MANUAL_BROWSER_VIEWPORTS[caseId],
          owner: 'supervised-human',
          cleanupStatus: 'PASS',
          evidence,
        };
        return { ...value, evidenceSha256: manualEvidenceSha256(value) };
      });
      const value = {
        schemaVersion: 1,
        identity,
        status: 'PASS',
        caseIds: MANUAL_BROWSER_CASE_IDS,
        cases,
        cleanupStatus: 'PASS',
      };
      details = { ...value, evidenceSha256: manualEvidenceSha256(value) };
    }
    return {
      status: 'PASS',
      safeCode: 'TEST_ROW_VERIFIED',
      exitCode: 0,
      completedAssertions: row.requiredAssertions,
      details,
      stdoutSha256: sha256(''),
      stderrSha256: sha256(''),
      stdoutBytes: 0,
      stderrBytes: 0,
      ...(attachments === undefined ? {} : { attachments }),
    };
  };
  const produced = await produceAiExportCertification({
    workspaceRoot,
    sourceCommit,
    profile: 'non-production',
    environment: 'test',
    attemptId: 'attempt-001',
    executeRow,
  });
  await assert.rejects(
    () => verifyAiExportCertification({ workspaceRoot, identity: produced.identity }),
    (error) => error?.code === 'CERTIFICATION_RELEASE_INDEX_MISSING',
  );
  const finalized = await finalizeAiExportCertification(produced);
  assert.equal(finalized.rollup.status, 'PASS');
  assert.equal(finalized.rollup.requiredInputCount, produced.records.length);
  assert.equal(finalized.releaseIndex.rollup.recordsSha256, finalized.rollup.recordsSha256);
  await assert.rejects(
    () => finalizeAiExportCertification(produced),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  const immutableRecord = join(produced.writer.attemptRoot, 'records', 'CERT-SECRET-SCAN.json');
  await chmod(immutableRecord, 0o644);
  await assert.rejects(
    () => verifyAiExportCertification({ workspaceRoot, identity: produced.identity }),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  await chmod(immutableRecord, 0o600);
  const alias = join(workspaceRoot, 'record-hardlink.json');
  await link(immutableRecord, alias);
  await assert.rejects(
    () => verifyAiExportCertification({ workspaceRoot, identity: produced.identity }),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  await unlink(alias);
  const releaseIndexPath = join(produced.writer.attemptRoot, 'release-index.json');
  const releaseIndexBytes = await readFile(releaseIndexPath);
  const staleIndex = JSON.parse(releaseIndexBytes.toString('utf8'));
  staleIndex.evidenceTreeSha256 = '0'.repeat(64);
  await writeFile(releaseIndexPath, `${canonicalJson(staleIndex)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => verifyAiExportCertification({ workspaceRoot, identity: produced.identity }),
    (error) => error?.code === 'CERTIFICATION_EVIDENCE_TREE_MISMATCH',
  );
  await writeFile(releaseIndexPath, releaseIndexBytes, { mode: 0o600 });
  await writeFile(join(produced.writer.attemptRoot, 'records', 'EXTRA.json'), '{}\n', {
    mode: 0o600,
  });
  await assert.rejects(
    () => verifyAiExportCertification({ workspaceRoot, identity: produced.identity }),
    (error) => error?.code === 'CERTIFICATION_ROW_SET_NOT_CLOSED',
  );
});

const markerPng = ({ rgb }) =>
  sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();

const markerPptx = async (markers) => {
  const presentation = new pptxgen();
  presentation.defineLayout({ name: 'CERTIFICATION', width: 16, height: 9 });
  presentation.layout = 'CERTIFICATION';
  for (const marker of markers) {
    const slide = presentation.addSlide();
    slide.addImage({
      data: `image/png;base64,${(await markerPng(marker)).toString('base64')}`,
      x: 0,
      y: 0,
      w: 16,
      h: 9,
    });
  }
  return Buffer.from(await presentation.write({ outputType: 'nodebuffer', compression: true }));
};

const markerPdf = (markers) => {
  const objects = new Map();
  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(2, Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'));
  markers.forEach((marker, index) => {
    const pageId = index === 0 ? 3 : 6;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const raw = Buffer.alloc(32 * 32 * 3);
    for (let offset = 0; offset < raw.length; offset += 3) {
      raw[offset] = marker.rgb[0];
      raw[offset + 1] = marker.rgb[1];
      raw[offset + 2] = marker.rgb[2];
    }
    const compressed = deflateSync(raw);
    const content = Buffer.from('q 32 0 0 32 0 0 cm /Im0 Do Q');
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    objects.set(
      imageId,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        ),
        compressed,
        Buffer.from('\nendstream'),
      ]),
    );
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
        content,
        Buffer.from('\nendstream'),
      ]),
    );
  });
  const parts = [Buffer.from('%PDF-1.4\n')];
  for (const [id, body] of [...objects.entries()].sort(([left], [right]) => left - right))
    parts.push(Buffer.from(`${id} 0 obj\n`), body, Buffer.from('\nendobj\n'));
  parts.push(Buffer.from('%%EOF\n'));
  return Buffer.concat(parts);
};

test('browser evidence uses the real producer shape and retained artifact markers in page order', async () => {
  const retained = EXPORT_VISUAL_MARKERS.retained;
  const artifacts = await verifyRetainedExportArtifacts({
    pdfBytes: markerPdf(retained),
    pptxBytes: await markerPptx(retained),
  });
  assert.deepEqual(artifacts.pdfMarkerIds, ['retained-alpha', 'retained-beta']);
  assert.deepEqual(artifacts.pptxMarkerIds, ['retained-alpha', 'retained-beta']);
  await assert.rejects(
    async () =>
      verifyRetainedExportArtifacts({
        pdfBytes: markerPdf(retained),
        pptxBytes: await markerPptx([...retained].reverse()),
      }),
    /Expected values to be strictly deep-equal/u,
  );
  await assert.rejects(
    async () =>
      verifyRetainedExportArtifacts({
        pdfBytes: markerPdf(EXPORT_VISUAL_MARKERS.head),
        pptxBytes: await markerPptx(retained),
      }),
    /Expected values to be strictly deep-equal/u,
  );
});

test('auth topology inputs are bounded canonical closed files bound to the current attempt', async (context) => {
  const directory = await mkdtemp(join(repositoryRoot, '.auth-topology-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    frontendPath: join(directory, 'frontend.json'),
    backendPath: join(directory, 'backend.json'),
    runtimePath: join(directory, 'runtime.json'),
  };
  const values = {
    frontendPath: {
      NEXT_PUBLIC_BOARD_API_URL: 'http://127.0.0.1:3411',
      NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:3412',
    },
    backendPath: {
      APP_ENV: 'test',
      BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410',
      BOARD_PUBLIC_API_ORIGIN: 'http://127.0.0.1:3411',
    },
    runtimePath: {
      ARTIFACT_RUNTIME_APP_ORIGIN: 'http://127.0.0.1:3410',
      ARTIFACT_RUNTIME_API_ORIGIN: 'http://127.0.0.1:3411',
      ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:3412',
    },
  };
  await Promise.all(
    Object.entries(paths).map(([key, path]) =>
      writeFile(path, `${canonicalJson(values[key])}\n`, { mode: 0o600 }),
    ),
  );
  await Promise.all(Object.values(paths).map((path) => chmod(path, 0o600)));
  const identity = {
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    profile: 'non-production',
    environment: 'test',
    attemptId: 'topology-attempt',
  };
  const evidence = await verifyAuthOriginTopology({ ...paths, identity });
  assert.equal(evidence.target.kind, 'submitted-deployment-topology');
  assert.match(evidence.target.bindingSha256, /^[0-9a-f]{64}$/u);
  await writeFile(
    paths.frontendPath,
    `${canonicalJson({ ...values.frontendPath, UNKNOWN_INPUT: 'rejected' })}\n`,
    { mode: 0o600 },
  );
  await Promise.all(Object.values(paths).map((path) => chmod(path, 0o600)));
  await assert.rejects(
    () => verifyAuthOriginTopology({ ...paths, identity }),
    /exact canonical schema/u,
  );
});

test('certification child environments drop ambient credentials and runtime injection', async () => {
  const canary = 'ambient-credential-canary';
  const environment = createCertificationChildEnvironment({
    PATH: process.env.PATH,
    NODE_OPTIONS: '--require=/definitely-missing-certification-hook.cjs',
    CLOUD_ACCESS_TOKEN: canary,
  });
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.CLOUD_ACCESS_TOKEN, undefined);
  const serviceEnvironment = buildServiceEnvironment({
    environment: {
      ...environment,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'fixture',
      MYSQL_PASSWORD: 'fixture-password',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_PASSWORD: 'fixture-password',
      REDIS_DB: '15',
      SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE: '/fixture/chromium',
      NODE_OPTIONS: '--require=/definitely-missing-certification-hook.cjs',
      CLOUD_ACCESS_TOKEN: canary,
    },
    attemptId: 'environment-attempt',
    database: 'sceneboard_cert_environment',
    ownerSha256: 'a'.repeat(64),
    origins: {
      apiPort: 45002,
      apiOrigin: 'http://127.0.0.1:45002',
      webOrigin: 'http://127.0.0.1:45001',
      runtimeOrigin: 'http://127.0.0.1:45003',
    },
  });
  assert.equal(serviceEnvironment.NODE_OPTIONS, undefined);
  assert.equal(serviceEnvironment.CLOUD_ACCESS_TOKEN, undefined);
  const supervisor = new CertificationProcessSupervisor({ workspaceRoot: repositoryRoot });
  const child = supervisor.start({
    id: 'environment-observation',
    command: process.execPath,
    args: ['scripts/verify-auth-origin-topology.mjs', '--self-test'],
    env: environment,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const code = await new Promise((resolveExit) => child.once('exit', resolveExit));
  assert.equal(code, 0, output);
  assert.equal(output.includes(canary), false);
});

test('direct Git and npm child environments neutralize selectors, loaders, and credentials', () => {
  const ambient = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_OPTIONS: '--require=/untrusted-loader.cjs',
    LD_PRELOAD: '/untrusted-loader.so',
    GIT_DIR: '/untrusted/repository',
    GIT_INDEX_FILE: '/untrusted/index',
    GIT_WORK_TREE: '/untrusted/worktree',
    GIT_CONFIG_GLOBAL: '/untrusted/gitconfig',
    CLOUD_ACCESS_TOKEN: 'cloud-credential-canary',
    CI_JOB_TOKEN: 'ci-credential-canary',
    MYSQL_PASSWORD: 'database-credential-canary',
    HTTP_PROXY: 'http://unrelated-proxy.invalid',
    NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
  };
  const gitEnvironment = createGitCertificationEnvironment(ambient);
  assert.deepEqual(
    {
      GIT_CONFIG_NOSYSTEM: gitEnvironment.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: gitEnvironment.GIT_CONFIG_GLOBAL,
      GIT_TERMINAL_PROMPT: gitEnvironment.GIT_TERMINAL_PROMPT,
      GIT_ASKPASS: gitEnvironment.GIT_ASKPASS,
    },
    {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
    },
  );
  const npmEnvironment = createNpmCertificationEnvironment(ambient, { network: true });
  assert.equal(npmEnvironment.NPM_CONFIG_REGISTRY, ambient.NPM_CONFIG_REGISTRY);
  for (const environment of [gitEnvironment, npmEnvironment]) {
    for (const key of [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_WORK_TREE',
      'CLOUD_ACCESS_TOKEN',
      'CI_JOB_TOKEN',
      'MYSQL_PASSWORD',
      'HTTP_PROXY',
    ])
      assert.equal(environment[key], undefined, key);
    assert.equal(Object.values(environment).join('\n').includes('credential-canary'), false);
  }
});

test('manual acceptance is canonical, closed, current, and content-addressed', () => {
  const identity = {
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    profile: 'non-production',
    environment: 'test',
    attemptId: 'attempt-manual',
  };
  const observedAt = new Date().toISOString();
  const cases = MANUAL_BROWSER_CASE_IDS.map((caseId) => {
    const content = `${caseId} sanitized observation`;
    const value = {
      caseId,
      status: 'PASS',
      provenance: {
        attemptId: identity.attemptId,
        sourceCommit: identity.sourceCommit,
        manifestSha256: identity.manifestSha256,
        observedAt,
        browserBuildSha256: 'c'.repeat(64),
      },
      viewport: MANUAL_BROWSER_VIEWPORTS[caseId],
      owner: 'supervised-human',
      cleanupStatus: 'PASS',
      evidence: { content, contentSha256: sha256(content), attachments: [] },
    };
    return { ...value, evidenceSha256: manualEvidenceSha256(value) };
  });
  const value = {
    schemaVersion: 1,
    identity,
    status: 'PASS',
    caseIds: MANUAL_BROWSER_CASE_IDS,
    cases,
    cleanupStatus: 'PASS',
  };
  const report = { ...value, evidenceSha256: manualEvidenceSha256(value) };
  assert.deepEqual(
    validateManualReportBytes(Buffer.from(`${canonicalJson(report)}\n`), identity),
    report,
  );
  const reordered = structuredClone(report);
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  assert.throws(
    () => validateManualReportBytes(Buffer.from(`${canonicalJson(reordered)}\n`), identity),
    (error) => error?.code === 'MANUAL_EVIDENCE_INVALID',
  );
  const altered = structuredClone(report);
  altered.cases[0].evidence.content = 'mutated';
  assert.throws(
    () => validateManualReportBytes(Buffer.from(`${canonicalJson(altered)}\n`), identity),
    (error) => error?.code === 'MANUAL_EVIDENCE_INVALID',
  );
});

test('browser certification owns its disposable database and isolated service lifecycle', async () => {
  const [producer, browser] = await Promise.all([
    readFile(new URL('../../scripts/certify-ai-export-contracts.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/certify-export-browser-e2e.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(producer, /createBrowserCertificationEnvironment/u);
  assert.match(producer, /SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true'/u);
  assert.match(producer, /SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'browser'/u);
  assert.match(browser, /CREATE DATABASE/u);
  assert.match(browser, /certification_fixture_owner/u);
  assert.match(browser, /persistence-certification\.bootstrap\.ts/u);
  assert.match(browser, /CertificationProcessSupervisor/u);
  assert.match(browser, /waitForHttpReadiness/u);
  assert.match(browser, /SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS/u);
  assert.match(browser, /stopAll/u);
});

test('browser certification producer derives the exact owned schema and rejects unsafe topology', () => {
  const environment = {
    APP_ENV: 'test',
    NODE_ENV: 'test',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_DATABASE: 'sceneboard',
    REDIS_HOST: '127.0.0.1',
    SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS: 'true',
  };
  const first = createBrowserCertificationEnvironment('attempt-browser-001', environment);
  const second = createBrowserCertificationEnvironment('attempt-browser-001', environment);
  assert.deepEqual(first, second);
  assert.match(first.MYSQL_DATABASE, /^sceneboard_cert_[a-f0-9]{20}$/u);
  assert.notEqual(first.MYSQL_DATABASE, environment.MYSQL_DATABASE);
  assert.equal(first.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE, 'true');
  assert.equal(first.SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE, 'browser');
  assert.match(first.SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      createBrowserCertificationEnvironment('attempt-browser-001', {
        ...environment,
        APP_ENV: 'development',
      }),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
  assert.throws(
    () =>
      createBrowserCertificationEnvironment('attempt-browser-001', {
        ...environment,
        SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS: 'false',
      }),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
  assert.throws(
    () => createBrowserCertificationEnvironment(undefined, environment),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
  assert.throws(
    () => createBrowserCertificationEnvironment('../attempt', environment),
    (error) => error?.code === 'CERTIFICATION_ENVIRONMENT_UNSAFE',
  );
});

test('browser certification readiness retries and cleanup runs every action', async () => {
  let readinessAttempts = 0;
  await waitForHttpReadiness({
    url: 'http://127.0.0.1:39999/ready',
    child: { exitCode: null },
    timeoutMs: 2_000,
    fetchImpl: async () => {
      readinessAttempts += 1;
      return {
        status: readinessAttempts === 1 ? 503 : 200,
        body: { cancel: async () => undefined },
      };
    },
  });
  assert.equal(readinessAttempts, 2);

  const executed = [];
  const errors = [];
  await runCleanupActions(
    [
      async () => executed.push('first'),
      async () => {
        executed.push('failed');
        throw new Error('synthetic cleanup failure');
      },
      async () => executed.push('last'),
    ],
    errors,
  );
  assert.deepEqual(executed.sort(), ['failed', 'first', 'last']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /synthetic cleanup failure/u);
});

test('browser certification executes the exact closed scenario set and aggregates cleanup failures', async () => {
  const browser = await readFile(
    new URL('../../scripts/certify-export-browser-e2e.mjs', import.meta.url),
    'utf8',
  );
  for (const scenarioId of BROWSER_SCENARIO_IDS) assert.match(browser, new RegExp(scenarioId, 'u'));
  assert.match(browser, /scenarioEvidence\.size !== BROWSER_SCENARIO_IDS\.length - 1/u);
  assert.match(browser, /Promise\.allSettled/u);
  assert.match(browser, /new AggregateError/u);
  assert.doesNotMatch(browser, /status: 'BLOCKED'/u);
});
