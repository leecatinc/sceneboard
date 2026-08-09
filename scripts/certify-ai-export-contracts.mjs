import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  canonicalJsonSha256,
  containsSecretLikeMaterial,
  sha256,
} from './lib/certification/canonical-json.mjs';
import { CertificationEvidenceWriter } from './lib/certification/evidence-writer.mjs';
import {
  certificationDatabaseName,
  certificationDatabaseOwnerSha256,
} from './lib/certification/fixture-ownership.mjs';
import {
  createCertificationChildEnvironment,
  createGitCertificationEnvironment,
} from './lib/certification/process-lifecycle.mjs';
import { validateSecurityLiveEvidence } from './lib/certification/security-catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentValues = new Set(['development', 'test', 'staging']);
const browserInputEnvironmentKeys = [
  'APP_ENV',
  'NODE_ENV',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
  'SCENEBOARD_TEST_USER_PASSWORD',
  'SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS',
];
const migrationInputEnvironmentKeys = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD'];
const restoreInputEnvironmentKeys = [
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'RETENTION_CERTIFICATE_HMAC_KEY',
  'AUDIT_HMAC_KEY_B64',
];
const generalCommandEnvironmentKeys = [
  'APP_ENV',
  'NODE_ENV',
  'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
];

export const createBrowserCertificationEnvironment = (attemptId, environment = process.env) => {
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attemptId)) {
    throw new CertificationError(
      'CERTIFICATION_ENVIRONMENT_UNSAFE',
      'browser certification requires a safe attempt identity',
    );
  }
  const fixtureAttemptId = `${attemptId}.browser`;
  if (
    environment.APP_ENV !== 'test' ||
    environment.NODE_ENV !== 'test' ||
    environment.MYSQL_HOST !== '127.0.0.1' ||
    environment.REDIS_HOST !== '127.0.0.1' ||
    environment.SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS !== 'true'
  ) {
    throw new CertificationError(
      'CERTIFICATION_ENVIRONMENT_UNSAFE',
      'browser certification requires test-only loopback MySQL and disposable Redis',
    );
  }
  return createCertificationChildEnvironment(environment, {
    allowedKeys: browserInputEnvironmentKeys,
    overrides: {
      MYSQL_DATABASE: certificationDatabaseName(fixtureAttemptId),
      SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
      SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'browser',
      SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256:
        certificationDatabaseOwnerSha256(fixtureAttemptId),
    },
  });
};

export const createMigrationCertificationEnvironment = (attemptId, environment = process.env) => {
  if (
    typeof attemptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attemptId) ||
    environment.MYSQL_HOST !== '127.0.0.1'
  ) {
    throw new CertificationError(
      'CERTIFICATION_ENVIRONMENT_UNSAFE',
      'migration certification requires a safe attempt identity and loopback MySQL',
    );
  }
  const fixtureAttemptId = `${attemptId}.migration`;
  return createCertificationChildEnvironment(environment, {
    allowedKeys: migrationInputEnvironmentKeys,
    overrides: {
      APP_ENV: 'test',
      NODE_ENV: 'test',
      MYSQL_DATABASE: certificationDatabaseName(fixtureAttemptId),
      SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
      SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'migration',
      SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256:
        certificationDatabaseOwnerSha256(fixtureAttemptId),
    },
  });
};

export const createRestoreCertificationEnvironment = (attemptId, environment = process.env) => {
  if (
    typeof attemptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attemptId) ||
    environment.MYSQL_HOST !== '127.0.0.1' ||
    environment.APP_ENV !== 'test' ||
    environment.NODE_ENV !== 'test'
  ) {
    throw new CertificationError(
      'CERTIFICATION_ENVIRONMENT_UNSAFE',
      'restore certification requires a safe attempt identity and test-only loopback MySQL',
    );
  }
  return createCertificationChildEnvironment(environment, {
    allowedKeys: restoreInputEnvironmentKeys,
    overrides: {
      APP_ENV: 'test',
      NODE_ENV: 'test',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
      SCENEBOARD_CERTIFICATION_RESTORE_FIXTURES_DISPOSABLE: 'true',
    },
  });
};

const packageRows = [
  ['PKG-BE-TEST', 'npm', ['test', '--workspace', 'sceneboard-be'], 'sceneboard-be', 'test'],
  [
    'PKG-BE-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', 'sceneboard-be'],
    'sceneboard-be',
    'typecheck',
  ],
  [
    'PKG-BE-BUILD',
    'npm',
    ['run', 'build', '--workspace', 'sceneboard-be'],
    'sceneboard-be',
    'build',
  ],
  ['PKG-FE-TEST', 'npm', ['test', '--workspace', 'sceneboard-fe'], 'sceneboard-fe', 'test'],
  [
    'PKG-FE-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', 'sceneboard-fe'],
    'sceneboard-fe',
    'typecheck',
  ],
  [
    'PKG-FE-BUILD',
    'npm',
    ['run', 'build', '--workspace', 'sceneboard-fe'],
    'sceneboard-fe',
    'build',
  ],
  ['PKG-MCP-TEST', 'npm', ['test', '--workspace', 'sceneboard-mcp'], 'sceneboard-mcp', 'test'],
  [
    'PKG-MCP-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', 'sceneboard-mcp'],
    'sceneboard-mcp',
    'typecheck',
  ],
  [
    'PKG-MCP-BUILD',
    'npm',
    ['run', 'build', '--workspace', 'sceneboard-mcp'],
    'sceneboard-mcp',
    'build',
  ],
  [
    'PKG-SCHEMA-TEST',
    'npm',
    ['test', '--workspace', '@sceneboard/board-schema'],
    '@sceneboard/board-schema',
    'test',
  ],
  [
    'PKG-SCHEMA-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', '@sceneboard/board-schema'],
    '@sceneboard/board-schema',
    'typecheck',
  ],
  [
    'PKG-SDK-TEST',
    'npm',
    ['test', '--workspace', '@sceneboard/board-sdk'],
    '@sceneboard/board-sdk',
    'test',
  ],
  [
    'PKG-SDK-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', '@sceneboard/board-sdk'],
    '@sceneboard/board-sdk',
    'typecheck',
  ],
  [
    'PKG-UI-TEST',
    'npm',
    ['test', '--workspace', '@sceneboard/board-ui'],
    '@sceneboard/board-ui',
    'test',
  ],
  [
    'PKG-UI-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', '@sceneboard/board-ui'],
    '@sceneboard/board-ui',
    'typecheck',
  ],
  [
    'PKG-RUNTIME-TEST',
    'npm',
    ['test', '--workspace', '@sceneboard/artifact-runtime'],
    '@sceneboard/artifact-runtime',
    'test',
  ],
  [
    'PKG-RUNTIME-TYPECHECK',
    'npm',
    ['run', 'typecheck', '--workspace', '@sceneboard/artifact-runtime'],
    '@sceneboard/artifact-runtime',
    'typecheck',
  ],
  [
    'PKG-RUNTIME-BUILD',
    'npm',
    ['run', 'build:runtime', '--workspace', '@sceneboard/artifact-runtime'],
    '@sceneboard/artifact-runtime',
    'build',
  ],
];

const integrationRows = [
  [
    'INT-AUTH-ORIGINS',
    'node',
    ['scripts/verify-auth-origin-topology.mjs', '--owned-attempt'],
    'root',
    'auth-topology',
  ],
  ['INT-CONFIG', 'npm', ['run', 'verify:config'], 'root', 'config'],
  ['INT-DEPENDENCIES', 'npm', ['run', 'verify:dependencies'], 'root', 'dependencies'],
  [
    'INT-PRESENTATION',
    'npm',
    ['run', 'verify:presentation-contracts'],
    'root',
    'presentation-contracts',
  ],
  ['INT-PLUGIN', 'npm', ['run', 'check:sceneboard-plugin'], 'root', 'plugin'],
  ['INT-SKILL', 'npm', ['run', 'check:sceneboard-skill'], 'root', 'skill'],
];

const certificationRows = [
  [
    'CERT-ARTIFACT-RUNTIME-BUILD',
    'artifact-runtime-build',
    '@sceneboard/artifact-runtime',
    'artifact-runtime-build',
  ],
  ['CERT-MIG-027', 'migration-027', 'sceneboard-be', 'migration'],
  ['CERT-PDF-GOLDEN', 'pdf-golden', 'sceneboard-be', 'pdf'],
  ['CERT-PPTX-GOLDEN', 'pptx-golden', 'sceneboard-be', 'pptx'],
  ['CERT-BROWSER-E2E', 'browser-e2e', 'integrated', 'browser'],
  ['CERT-RUNTIME-SMOKE', 'runtime-smoke', 'sceneboard-be', 'runtime'],
  ['CERT-LOCAL-HELPER', 'local-helper', 'sceneboard-mcp', 'native-helper'],
  ['CERT-SECRET-SCAN', 'secret-scan', 'root', 'secret-scan'],
  ['CERT-SECURITY-LIVE', 'security-live', 'integrated', 'security-live'],
  ['CERT-BACKUP-RESTORE', 'backup-restore', 'sceneboard-be', 'backup-restore'],
  ['CERT-RESTORE-LIVE', 'restore-live', 'sceneboard-be', 'restore-live'],
  ['CERT-DATABASE-BOUNDARY', 'database-boundary', 'sceneboard-be', 'database'],
  ['CERT-WORKSPACE-BOUNDARY', 'workspace-boundary', 'root', 'workspace-boundary'],
  ['CERT-TRACEABILITY', 'traceability', 'root', 'traceability'],
].map(([id, caseName, packageName, surface]) => [
  id,
  'node',
  ['scripts/certify-ai-export-contracts.mjs', `--case=${caseName}`],
  packageName,
  surface,
]);

const manualRows = [
  ['MANUAL-BROWSER-ACCEPTANCE', 'manual', ['browser-acceptance'], 'integrated', 'manual-browser'],
];

export const BROWSER_SCENARIO_IDS = [
  'owner-session-pdf',
  'scoped-api-key-pptx',
  'missing-key-denial',
  'insufficient-key-denial',
  'viewer-control-denial',
  'editor-control-denial',
  'public-share-control-denial',
  'cross-account-denial',
  'pairing-regression',
  'retained-non-head-revision',
  'pdf-page-signature-order',
  'pptx-slide-signature-order',
  'cancel-aborts',
  'retryable-failure-retry',
  'non-retryable-failure-no-retry',
  'focus-restoration',
  'viewport-320',
  'board-head-revision-invariance',
  'credential-and-fixture-cleanup',
];

const browserEvidenceKeys = [
  'schemaVersion',
  'status',
  'scenarios',
  'payloadDigests',
  'artifactSemantics',
  'targetTopology',
  'cleanupStatus',
];
const browserArtifactSemanticKeys = [
  'schemaVersion',
  'revision',
  'expectedMarkerIds',
  'pdfMarkerIds',
  'pptxMarkerIds',
  'absentHeadMarkerIds',
  'pdfArtifactSha256',
  'pptxArtifactSha256',
];
const retainedMarkerIds = ['retained-alpha', 'retained-beta'];
const headMarkerIds = ['head-alpha', 'head-beta'];

export const validateBrowserEvidence = (details) => {
  assertExactKeys(details, browserEvidenceKeys, 'BROWSER_EVIDENCE_INVALID');
  if (
    details.schemaVersion !== 1 ||
    details.status !== 'PASS' ||
    details.cleanupStatus !== 'PASS' ||
    !Array.isArray(details.scenarios)
  )
    throw new CertificationError('BROWSER_EVIDENCE_INVALID');
  if (
    canonicalJson(details.scenarios.map(({ id }) => id)) !== canonicalJson(BROWSER_SCENARIO_IDS) ||
    details.scenarios.some((scenario) => {
      try {
        assertExactKeys(scenario, ['id', 'status', 'evidenceSha256'], 'BROWSER_EVIDENCE_INVALID');
      } catch {
        return true;
      }
      return scenario.status !== 'PASS' || !/^[0-9a-f]{64}$/u.test(scenario.evidenceSha256);
    })
  )
    throw new CertificationError('BROWSER_SCENARIO_SET_INCOMPLETE');
  assertExactKeys(details.payloadDigests, ['before', 'after'], 'BROWSER_EVIDENCE_INVALID');
  if (
    !/^[0-9a-f]{64}$/u.test(details.payloadDigests.before) ||
    details.payloadDigests.before !== details.payloadDigests.after
  )
    throw new CertificationError('BROWSER_PAYLOAD_MUTATION_DETECTED');
  assertExactKeys(
    details.artifactSemantics,
    browserArtifactSemanticKeys,
    'BROWSER_EVIDENCE_INVALID',
  );
  const semantics = details.artifactSemantics;
  if (
    semantics.schemaVersion !== 1 ||
    semantics.revision !== 'retained' ||
    canonicalJson(semantics.expectedMarkerIds) !== canonicalJson(retainedMarkerIds) ||
    canonicalJson(semantics.pdfMarkerIds) !== canonicalJson(retainedMarkerIds) ||
    canonicalJson(semantics.pptxMarkerIds) !== canonicalJson(retainedMarkerIds) ||
    canonicalJson(semantics.absentHeadMarkerIds) !== canonicalJson(headMarkerIds) ||
    ![semantics.pdfArtifactSha256, semantics.pptxArtifactSha256].every((value) =>
      /^[0-9a-f]{64}$/u.test(value),
    )
  )
    throw new CertificationError('BROWSER_ARTIFACT_SEMANTICS_INVALID');
  assertExactKeys(
    details.targetTopology,
    ['kind', 'attemptId', 'databaseOwnerSha256', 'frontendOrigin', 'apiOrigin', 'runtimeOrigin'],
    'BROWSER_EVIDENCE_INVALID',
  );
  const topology = details.targetTopology;
  const origins = [topology.frontendOrigin, topology.apiOrigin, topology.runtimeOrigin];
  if (
    topology.kind !== 'isolated-loopback-browser-fixture' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(topology.attemptId) ||
    !/^[0-9a-f]{64}$/u.test(topology.databaseOwnerSha256) ||
    new Set(origins).size !== 3 ||
    origins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.origin !== origin || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
        );
      } catch {
        return true;
      }
    })
  )
    throw new CertificationError('BROWSER_TARGET_TOPOLOGY_INVALID');
  return details;
};

export const MANUAL_BROWSER_CASE_IDS = [
  'PAGES-DESKTOP',
  'PAGES-MOBILE-P',
  'PAGES-MOBILE-L',
  'PRESENTATION',
  'SHARING',
  'MEDIA',
  'ANALYTICS',
  'EXPORT',
  'API-KEY/PAIRING',
];

export const MANUAL_BROWSER_VIEWPORTS = Object.freeze({
  'PAGES-DESKTOP': ['1440x900'],
  'PAGES-MOBILE-P': ['320x568'],
  'PAGES-MOBILE-L': ['568x320'],
  PRESENTATION: ['1440x900'],
  SHARING: ['1440x900'],
  MEDIA: ['1440x900', '320x568'],
  ANALYTICS: ['1440x900'],
  EXPORT: ['1440x900', '320x568'],
  'API-KEY/PAIRING': ['1440x900'],
});

const MAX_MANUAL_REPORT_BYTES = 256 * 1024;
const MANUAL_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const TRACEABILITY_AUTHORITY_PATH = 'docs/operations/contract-certification-manifest.md';
const MAX_TRACEABILITY_AUTHORITY_BYTES = 64 * 1024;
const TRACEABILITY_START = '<!-- I53_TRACEABILITY_AUTHORITY_V1\n';
const TRACEABILITY_END = '\nI53_TRACEABILITY_AUTHORITY_V1 -->';

export const manualEvidenceSha256 = (value) => canonicalJsonSha256(value);

const invalidManualEvidence = () => {
  throw new CertificationError('MANUAL_EVIDENCE_INVALID');
};

export const validateManualReportBytes = (bytes, identity, now = Date.now()) => {
  const input = Buffer.from(bytes);
  if (input.length === 0 || input.length > MAX_MANUAL_REPORT_BYTES || input.includes(0))
    invalidManualEvidence();
  let report;
  try {
    report = JSON.parse(input.toString('utf8'));
  } catch {
    invalidManualEvidence();
  }
  if (input.toString('utf8') !== `${canonicalJson(report)}\n`) invalidManualEvidence();
  assertExactKeys(
    report,
    ['schemaVersion', 'identity', 'status', 'caseIds', 'cases', 'cleanupStatus', 'evidenceSha256'],
    'MANUAL_EVIDENCE_INVALID',
  );
  const reportWithoutHash = {
    schemaVersion: report.schemaVersion,
    identity: report.identity,
    status: report.status,
    caseIds: report.caseIds,
    cases: report.cases,
    cleanupStatus: report.cleanupStatus,
  };
  if (
    report.schemaVersion !== 1 ||
    canonicalJson(report.identity) !== canonicalJson(identity) ||
    report.status !== 'PASS' ||
    report.cleanupStatus !== 'PASS' ||
    canonicalJson(report.caseIds) !== canonicalJson(MANUAL_BROWSER_CASE_IDS) ||
    !Array.isArray(report.cases) ||
    report.cases.length !== MANUAL_BROWSER_CASE_IDS.length ||
    report.evidenceSha256 !== manualEvidenceSha256(reportWithoutHash) ||
    containsSecretLikeMaterial(canonicalJson(report))
  )
    invalidManualEvidence();
  for (const [index, record] of report.cases.entries()) {
    assertExactKeys(
      record,
      [
        'caseId',
        'status',
        'provenance',
        'viewport',
        'owner',
        'cleanupStatus',
        'evidence',
        'evidenceSha256',
      ],
      'MANUAL_EVIDENCE_INVALID',
    );
    assertExactKeys(
      record.provenance,
      ['attemptId', 'sourceCommit', 'manifestSha256', 'observedAt', 'browserBuildSha256'],
      'MANUAL_EVIDENCE_INVALID',
    );
    assertExactKeys(
      record.evidence,
      ['content', 'contentSha256', 'attachments'],
      'MANUAL_EVIDENCE_INVALID',
    );
    const observedAt = Date.parse(record.provenance.observedAt);
    if (
      record.caseId !== MANUAL_BROWSER_CASE_IDS[index] ||
      record.status !== 'PASS' ||
      record.cleanupStatus !== 'PASS' ||
      record.owner !== 'supervised-human' ||
      canonicalJson(record.viewport) !== canonicalJson(MANUAL_BROWSER_VIEWPORTS[record.caseId]) ||
      record.provenance.attemptId !== identity.attemptId ||
      record.provenance.sourceCommit !== identity.sourceCommit ||
      record.provenance.manifestSha256 !== identity.manifestSha256 ||
      !Number.isFinite(observedAt) ||
      observedAt > now ||
      now - observedAt > MANUAL_EVIDENCE_MAX_AGE_MS ||
      !/^[0-9a-f]{64}$/u.test(record.provenance.browserBuildSha256) ||
      typeof record.evidence.content !== 'string' ||
      record.evidence.content.length === 0 ||
      Buffer.byteLength(record.evidence.content) > 4_096 ||
      record.evidence.contentSha256 !== sha256(record.evidence.content) ||
      !Array.isArray(record.evidence.attachments) ||
      record.evidence.attachments.length > 8
    )
      invalidManualEvidence();
    for (const attachment of record.evidence.attachments) {
      assertExactKeys(
        attachment,
        ['mediaType', 'content', 'contentSha256'],
        'MANUAL_EVIDENCE_INVALID',
      );
      if (
        !['text/plain', 'application/json'].includes(attachment.mediaType) ||
        typeof attachment.content !== 'string' ||
        attachment.content.length === 0 ||
        Buffer.byteLength(attachment.content) > 16_384 ||
        attachment.contentSha256 !== sha256(attachment.content)
      )
        invalidManualEvidence();
    }
    const { evidenceSha256, ...recordWithoutHash } = record;
    if (evidenceSha256 !== manualEvidenceSha256(recordWithoutHash)) invalidManualEvidence();
  }
  return report;
};

const expectedTraceabilityMappings = Object.freeze([
  ['REQ-134', 'I-45', 'D1', 'PKG-SCHEMA-TEST', 'schema-contract-test'],
  ['REQ-135', 'I-46', 'D2', 'INT-AUTH-ORIGINS', 'auth-origin-topology'],
  ['REQ-136', 'I-47', 'D3', 'PKG-BE-TEST', 'application-contract-test'],
  ['REQ-137', 'I-48', 'D4', 'PKG-SDK-TEST', 'sdk-contract-test'],
  ['REQ-138', 'I-49', 'D5', 'PKG-FE-TEST', 'browser-control-test'],
  ['REQ-139', 'I-50', 'D6', 'CERT-RUNTIME-SMOKE', 'runtime-smoke'],
  ['REQ-140', 'I-51', 'D7', 'CERT-PDF-GOLDEN', 'pdf-golden'],
  ['REQ-141', 'I-52', 'D8', 'CERT-SECRET-SCAN', 'secret-scan'],
  ['REQ-142', 'I-53', 'D9', 'CERT-MIG-027', 'migration-projection'],
  ['REQ-143', 'I-53', 'D10', 'CERT-BROWSER-E2E', 'browser-scenarios'],
  ['REQ-144', 'I-53', 'D10', 'MANUAL-BROWSER-ACCEPTANCE', 'supervised-browser-observation'],
]).map(([requirementId, issueId, owner, producerRowId, evidenceKind]) => ({
  requirementId,
  issueId,
  owner,
  producerRowId,
  evidenceKind,
}));
const expectedTraceabilityTools = Object.freeze([
  {
    toolName: 'board_export',
    issueId: 'I-53',
    owner: 'D10',
    producerRowId: 'CERT-BROWSER-E2E',
    evidenceKind: 'explicit-revision-browser-export',
  },
]);

const readTraceabilityAuthority = () => {
  const path = resolve(root, TRACEABILITY_AUTHORITY_PATH);
  const before = lstatSync(path, { bigint: true });
  const workspaceOwner = lstatSync(root, { bigint: true }).uid;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.uid !== workspaceOwner ||
    (before.mode & 0o002n) !== 0n ||
    realpathSync(path) !== path
  )
    throw new CertificationError('TRACEABILITY_AUTHORITY_OWNERSHIP_INVALID');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev !== before.dev || metadata.ino !== before.ino)
      throw new CertificationError('TRACEABILITY_AUTHORITY_OWNERSHIP_INVALID');
    const bytes = readFileSync(descriptor);
    if (bytes.length === 0 || bytes.length > MAX_TRACEABILITY_AUTHORITY_BYTES || bytes.includes(0))
      throw new CertificationError('TRACEABILITY_AUTHORITY_INVALID');
    const text = bytes.toString('utf8');
    const start = text.indexOf(TRACEABILITY_START);
    const end = text.indexOf(TRACEABILITY_END);
    if (start < 0 || end < 0 || text.indexOf(TRACEABILITY_START, start + 1) >= 0 || end <= start)
      throw new CertificationError('TRACEABILITY_AUTHORITY_INVALID');
    const source = text.slice(start + TRACEABILITY_START.length, end);
    let authority;
    try {
      authority = JSON.parse(source);
    } catch {
      throw new CertificationError('TRACEABILITY_AUTHORITY_INVALID');
    }
    if (source !== canonicalJson(authority))
      throw new CertificationError('TRACEABILITY_AUTHORITY_INVALID');
    assertExactKeys(
      authority,
      ['schemaVersion', 'mappings', 'tools'],
      'TRACEABILITY_AUTHORITY_INVALID',
    );
    if (
      authority.schemaVersion !== 1 ||
      canonicalJson(authority.mappings) !== canonicalJson(expectedTraceabilityMappings) ||
      canonicalJson(authority.tools) !== canonicalJson(expectedTraceabilityTools)
    )
      throw new CertificationError('TRACEABILITY_AUTHORITY_INVALID');
    return { authority, authoritySha256: sha256(source) };
  } finally {
    closeSync(descriptor);
  }
};

export const createTraceabilityEvidence = (identity) => {
  const { authority, authoritySha256 } = readTraceabilityAuthority();
  return {
    schemaVersion: 1,
    authorityPath: TRACEABILITY_AUTHORITY_PATH,
    authoritySha256,
    sourceManifestSha256: identity.manifestSha256,
    attemptId: identity.attemptId,
    mappings: authority.mappings,
    tools: authority.tools,
  };
};

export const validateTraceabilityEvidence = (details, identity) => {
  assertExactKeys(
    details,
    [
      'schemaVersion',
      'authorityPath',
      'authoritySha256',
      'sourceManifestSha256',
      'attemptId',
      'mappings',
      'tools',
    ],
    'TRACEABILITY_EVIDENCE_INVALID',
  );
  const expected = createTraceabilityEvidence(identity);
  if (canonicalJson(details) !== canonicalJson(expected))
    throw new CertificationError('TRACEABILITY_EVIDENCE_INVALID');
  return details;
};

const defaultAssertions = ['command-completed', 'no-skipped-assertions'];
const rowFrom = ([id, executable, args, packageName, surface]) => ({
  id,
  command: [executable, ...args].join(' '),
  executable,
  args,
  package: packageName,
  surface,
  artifactKind:
    id === 'CERT-BROWSER-E2E'
      ? 'browser-scenarios/v1'
      : id === 'INT-AUTH-ORIGINS'
        ? 'auth-origin-topology/v3'
        : id === 'CERT-SECRET-SCAN'
          ? 'secret-scan/v2'
          : id === 'CERT-SECURITY-LIVE'
            ? 'security-live-aggregate/v1'
            : 'command-result/v1',
  requiredAssertions:
    id === 'CERT-BROWSER-E2E'
      ? BROWSER_SCENARIO_IDS
      : id === 'INT-AUTH-ORIGINS'
        ? ['target-inputs-closed', 'topology-matched', 'evidence-unexpired']
        : id === 'CERT-SECRET-SCAN'
          ? ['tracked-worktree', 'index', 'head', 'command-output', 'evidence', 'archives']
          : id === 'CERT-SECURITY-LIVE'
            ? ['exact-live-case-set', 'every-live-case-pass', 'exact-owned-fixture-clean']
            : id === 'CERT-RESTORE-LIVE'
              ? [
                  'attempt-owned-backup',
                  'quarantine-restore',
                  'media-byte-integrity',
                  'schema-projection',
                  'restricted-operator',
                  'zero-residue-cleanup',
                ]
              : id === 'CERT-DATABASE-BOUNDARY'
                ? [
                    'static-schema-sql-cli',
                    'fresh',
                    'bounded-restart',
                    'resumable-audit',
                    'terminal-projection',
                    'adopt',
                    'zero-residue-cleanup',
                  ]
                : defaultAssertions,
});

export const AI_EXPORT_REQUIRED_ROWS = [
  ...packageRows,
  ...integrationRows,
  ...certificationRows,
  ...manualRows,
].map(rowFrom);

export const createAiExportManifest = () => ({
  schemaVersion: 2,
  issue: 'I-53',
  acceptanceCriterion: 'I53-AC-PRESENTATION',
  testCase: 'I53-TC-PRESENTATION-01',
  requiredRows: AI_EXPORT_REQUIRED_ROWS,
  derivedRow: {
    id: 'CERT-ROLLUP',
    artifactKind: 'immutable-rollup/v2',
  },
});

export const aiExportManifestSha256 = () =>
  sha256(Buffer.from(`${canonicalJson(createAiExportManifest())}\n`));

const runProcess = (
  executable,
  args,
  environment = createCertificationChildEnvironment(process.env, {
    allowedKeys: generalCommandEnvironmentKeys,
  }),
  input,
) => {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const secretDetected = containsSecretLikeMaterial(stdout) || containsSecretLikeMaterial(stderr);
  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    secretDetected,
    skipped: /# skipped [1-9][0-9]*/u.test(`${stdout}\n${stderr}`),
  };
};

const outputEnvelope = (run) => ({
  stdoutSha256: sha256(run.stdout),
  stderrSha256: sha256(run.stderr),
  stdoutBytes: Buffer.byteLength(run.stdout),
  stderrBytes: Buffer.byteLength(run.stderr),
});

const commandReport = (run, details = {}) => {
  const pass = run.exitCode === 0 && !run.skipped && !run.secretDetected;
  return {
    status: pass ? 'PASS' : run.secretDetected ? 'FAIL' : run.skipped ? 'UNVERIFIED' : 'FAIL',
    safeCode: pass
      ? 'COMMAND_VERIFIED'
      : run.secretDetected
        ? 'SECRET_LIKE_COMMAND_OUTPUT'
        : run.skipped
          ? 'COMMAND_REPORTED_SKIPPED_ASSERTIONS'
          : 'COMMAND_FAILED',
    exitCode: run.exitCode,
    completedAssertions: pass ? defaultAssertions : [],
    details,
    ...outputEnvelope(run),
  };
};

const combineCommandRuns = (runs) => ({
  exitCode: runs.every(({ exitCode }) => exitCode === 0) ? 0 : 1,
  stdout: runs.map(({ stdout }) => stdout).join(''),
  stderr: runs.map(({ stderr }) => stderr).join(''),
  secretDetected: runs.some(({ secretDetected }) => secretDetected),
  skipped: runs.some(({ skipped }) => skipped),
});

const databaseBoundaryScenarios = [
  'fresh',
  'bounded-restart',
  'projection',
  'terminal-registry',
  'resumable-audit',
  'adopt',
  'zero-residue-cleanup',
];

export const validateDatabaseBoundaryReport = (stdout, attemptId) => {
  let report;
  try {
    const lines = stdout.trim().split('\n');
    report = JSON.parse(lines.at(-1));
  } catch {
    throw new CertificationError('DATABASE_BOUNDARY_EVIDENCE_INVALID');
  }
  assertExactKeys(
    report,
    [
      'schemaVersion',
      'status',
      'target',
      'databaseOwnerSha256',
      'terminalVersion',
      'scenarios',
      'cleanupStatus',
    ],
    'DATABASE_BOUNDARY_EVIDENCE_INVALID',
  );
  const expectedOwnerSha256 = certificationDatabaseOwnerSha256(`${attemptId}.migration`);
  if (
    report.schemaVersion !== 1 ||
    report.status !== 'PASS' ||
    report.target !== 'disposable-loopback-mysql' ||
    report.databaseOwnerSha256 !== expectedOwnerSha256 ||
    !/^[0-9]{3}_[a-z0-9_]+$/u.test(report.terminalVersion) ||
    canonicalJson(report.scenarios) !== canonicalJson(databaseBoundaryScenarios) ||
    report.cleanupStatus !== 'PASS'
  ) {
    throw new CertificationError('DATABASE_BOUNDARY_EVIDENCE_INVALID');
  }
  return report;
};

const restoreReportKeys = [
  'schemaVersion',
  'attemptId',
  'deploymentId',
  'attemptSeq',
  'sourceSchemaSha256',
  'sourceOwnerSha256',
  'quarantineSchemaSha256',
  'quarantineOwnerSha256',
  'operatorPrincipalSha256',
  'startedAt',
  'restoredAt',
  'certifiedAt',
  'expiresAt',
  'sourceBackupSha256',
  'registrySha256',
  'mediaManifestSha256',
  'schemaProjectionSha256',
  'integritySha256',
  'cleanupStatus',
  'evidenceSha256',
  'status',
];

export const validateRestoreLiveReport = (stdout, attemptId, now = Date.now()) => {
  let report;
  try {
    report = JSON.parse(stdout.trim().split('\n').at(-1));
  } catch {
    throw new CertificationError('RESTORE_LIVE_EVIDENCE_INVALID');
  }
  assertExactKeys(report, restoreReportKeys, 'RESTORE_LIVE_EVIDENCE_INVALID');
  const startedAt = Date.parse(report.startedAt);
  const restoredAt = Date.parse(report.restoredAt);
  const certifiedAt = Date.parse(report.certifiedAt);
  const expiresAt = Date.parse(report.expiresAt);
  const digestValues = restoreReportKeys
    .filter((key) => key.endsWith('Sha256') && key !== 'evidenceSha256')
    .map((key) => report[key]);
  const evidence = Object.fromEntries(
    Object.entries(report).filter(([key]) => !['evidenceSha256', 'status'].includes(key)),
  );
  const sourceSchema = `sceneboard_cert_${sha256(`${attemptId}.restore.source`).slice(0, 20)}`;
  const quarantineSchema = `sceneboard_cert_${sha256(`${attemptId}.restore.quarantine`).slice(0, 20)}`;
  if (
    report.schemaVersion !== 2 ||
    report.attemptId !== attemptId ||
    report.deploymentId !== `cert-${sha256(attemptId).slice(0, 24)}` ||
    report.attemptSeq !== 1 ||
    report.sourceSchemaSha256 !== sha256(sourceSchema) ||
    report.quarantineSchemaSha256 !== sha256(quarantineSchema) ||
    report.sourceOwnerSha256 !== sha256(`sceneboard-certification-restore:${attemptId}:source`) ||
    report.quarantineOwnerSha256 !==
      sha256(`sceneboard-certification-restore:${attemptId}:quarantine`) ||
    digestValues.some((value) => !/^[0-9a-f]{64}$/u.test(value)) ||
    ![startedAt, restoredAt, certifiedAt, expiresAt].every(Number.isFinite) ||
    startedAt > restoredAt ||
    restoredAt > certifiedAt ||
    certifiedAt > now ||
    now - certifiedAt > 15 * 60 * 1_000 ||
    expiresAt - certifiedAt !== 30 * 24 * 60 * 60 * 1_000 ||
    report.cleanupStatus !== 'PASS' ||
    report.status !== 'PASS' ||
    report.evidenceSha256 !== sha256(canonicalJson(evidence))
  ) {
    throw new CertificationError('RESTORE_LIVE_EVIDENCE_INVALID');
  }
  return report;
};

const readText = (path) => {
  const bytes = readFileSync(path);
  return bytes.length <= 16 * 1024 * 1024 && !bytes.includes(0) ? bytes.toString('utf8') : '';
};

const sameFileState = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.nlink === right.nlink &&
  left.uid === right.uid &&
  left.mode === right.mode &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const readOwnedCanonicalJsonInput = (path, code, byteLimit = 16 * 1024 * 1024) => {
  if (typeof path !== 'string' || path !== resolve(path)) throw new CertificationError(code);
  let canonicalPath;
  let before;
  try {
    canonicalPath = realpathSync(path);
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new CertificationError(code);
  }
  const offset = relative(root, canonicalPath);
  if (
    canonicalPath !== path ||
    offset === '' ||
    offset === '..' ||
    offset.startsWith(`..${sep}`) ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(byteLimit) ||
    (process.getuid && before.uid !== BigInt(process.getuid())) ||
    (before.mode & 0o077n) !== 0n
  )
    throw new CertificationError(code);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileState(opened, before)) throw new CertificationError(code);
    const bytes = readFileSync(descriptor);
    let afterDescriptor;
    let afterPath;
    let afterCanonicalPath;
    try {
      afterDescriptor = fstatSync(descriptor, { bigint: true });
      afterPath = lstatSync(path, { bigint: true });
      afterCanonicalPath = realpathSync(path);
    } catch {
      throw new CertificationError(code);
    }
    if (
      bytes.length > byteLimit ||
      afterCanonicalPath !== canonicalPath ||
      afterPath.isSymbolicLink() ||
      !sameFileState(opened, afterDescriptor) ||
      !sameFileState(opened, afterPath)
    )
      throw new CertificationError(code);
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CertificationError(code);
    }
    if (bytes.toString('utf8') !== `${canonicalJson(value)}\n`) throw new CertificationError(code);
    return { value, bytes: Buffer.from(bytes), sha256: sha256(bytes) };
  } finally {
    closeSync(descriptor);
  }
};

// These hashes authorize exact reviewed source snapshots, not patterns or path-wide exemptions.
const approvedSyntheticSourceSha256 = new Map(
  Object.entries({
    'docs/operations/full-browser-test-scenario.md': [
      '1fc74d0775a805f5e9b52830e803593111416b702a206c44b4b4228eca11830a',
    ],
    'docs/operations/incident-response.md': [
      'b93e4153f9f92cc8cbc6e7782b8672b6b7b1d39349e2456276c18ee51fbf27de',
    ],
    'package-lock.json': ['a98c499f028ace61f5bf72d7a1c4b743a40ddcacc8ba210e717bc13f9e15aed7'],
    'packages/board-schema/test/event-snapshot-error-contract.test.ts': [
      'd3fa70b764f0e44ce5c1d8df9858a64dfdda074fcd3525dd1dfda5b92b389dad',
    ],
    'packages/board-schema/test/fixture-catalog.ts': [
      'dc26a7d6c79098a311b692b4ed5d96fa55b40dd8bffd86b7d579b38cd70becc8',
    ],
    'packages/board-sdk/test/events/event-reconciler.test.ts': [
      '84f385e5a9cd2464156be36835e88bf17a440eacc084473c5024620e164b21d7',
    ],
    'sceneboard-be/src/invitations/invitation.service.ts': [
      'c21b41397340a3eea09f7a8611a1e01f3b0e38ca5d6bffb5c38d7e675dfe932b',
    ],
    'sceneboard-be/src/pairing/pairing.service.ts': [
      '2d2a09f2ed69460f7be1d0da9948cf71f92e24e8c2d3ce01fe0c597eedd72ca2',
    ],
    'sceneboard-be/test/api-keys/account-api-key-board-authorization.test.ts': [
      'ba77ce238d86123b889b70e776b0883782520d4e58b17e79344aec761cbbaca8',
    ],
    'sceneboard-be/test/api-keys/account-api-key-management.controller.test.ts': [
      '1669aa74f642c60fc3ce519933ca763d87039b001b7ab1d92d0ed091cfa335aa',
    ],
    'sceneboard-be/test/api-keys/account-api-key-token.codec.test.ts': [
      'f1a0b94b068ad5b08760e1638f1361307f6717abb630a1d8519f26ed3aa587b0',
    ],
    'sceneboard-be/test/auth/board-principal-guard.test.ts': [
      'f0b9816d7705dcaab65e033cde37db30de23f307840f76af33b05ea1f1692412',
    ],
    'sceneboard-be/test/contracts/d1-actor-adapter.test.ts': [
      'f99887d6eb7a375f429519a4b1d5a53b9e24573b760ae1af3c0d6398a6ae3ee2',
    ],
    'sceneboard-be/test/pairing/pairing-primitives.test.ts': [
      '33bbe8d29387556f22fd357a0e727b3d208b0452bb83e0166aa2c020fa3e2ad3',
    ],
    'sceneboard-be/test/pairing/pairing-service.test.ts': [
      '2d9e15feb22b8129918d1ae045f0fcfb590fd4a7f44be4eb97797ab452f40ecd',
    ],
    'sceneboard-be/test/security/audit-contract.test.ts': [
      'b33eb6912df5a45860a8309226b1e1ad351f6a05d56eec7d4e5428f0d2724503',
    ],
    'sceneboard-be/test/security/crypto-redaction.test.ts': [
      'd319b7159e011ff784922bcea0ff3b84039f361adf6e449a698bdb75fb669f75',
    ],
    'sceneboard-fe/lib/api/public-share-server.ts': [
      '54094f8ce33cad72ee5800bd0bec803d57b9e353226e340d8e461896e8b0f071',
    ],
    'sceneboard-fe/test/api/account-api-key-api.test.ts': [
      '751106fc699a1f3c48766be38327c3a9a29fb967fdb6cbd0701a2c61861e34b9',
    ],
    'sceneboard-fe/test/api/board-api.test.ts': [
      '04b123c1b6a7db6e75a4a7f9655f07e4512832e16a87a716298cbbac5b6b6a31',
    ],
    'sceneboard-fe/test/api/d7-artifact-api.test.ts': [
      'fb0fb8a2ab137940e71b9c2444d8bde878187c71c4c688400a3fec087f2990e0',
    ],
    'sceneboard-fe/test/api/d8-hitl-api.test.ts': [
      'ce738a9b9fc3949d342057d8c73d9f0dba04f68f805da1c9d08b965859e9266c',
    ],
    'sceneboard-fe/test/routes/created-pairing-session.test.ts': [
      'e9722aa4a80f2e883bbc4921c3f547e146c01609cd90ec928ddedfaae7d131dd',
    ],
    'sceneboard-mcp/test/config/file-mode-and-secret-ref.test.ts': [
      '9ad4b0f3a5902bcb0854c2623cd38f871e0d4b9a47b06a17ca545cfe4cfdbc56',
    ],
    'sceneboard-mcp/test/server/server-composition.test.ts': [
      '1265b79c2e3b5e7e944625a9893a5dada65f4945a4b32d1e752eda9a6c3958cd',
    ],
    'sceneboard-mcp/test/tools/pairing-scope-order.contract.test.ts': [
      '034b5e77087e5e882e285bba2276fee638140572b8b571353b2add43f528b909',
    ],
    'scripts/lib/certification/security-catalog.mjs': [
      '33488a8d5a79bf4d6a8a5007442762c7b88137fc5fc18c610cd694d39cf4891d',
    ],
    'test/certification/contract-input-inventory.v1.json': [
      'e7099a6bdd98e4f75eb11dce66462f91ec9b50e4082f3a50c1bba2e6f8ab055c',
      'e20d74f1df29df5cc3d62f0932b262d312503f92f846d58cb43fe7a2534ed08f',
      '087f3a48b2da212404db58ca0865b65bd0b59ae00e90007451bf3ee775c186a2',
    ],
    'test/certification/contract-manifest.v1.json': [
      'a1bca7679febd33ce76a4a201b7bb2205afa8d1e068e0e036ff9ecff8015663c',
      'c87926dbb78033e15f505dac246989db01a77e5dc309860496d3c7e5a5aa13c9',
      '5d9656261eefc8c706eb07e0f8500a953044875f9f7e5b283e36741dd88890be',
    ],
    'test/certification/dependency-inventory.v1.json': [
      'cefeb8b1387a980d16da34fdcea1415cff6d07e92cb8bb745285ff97a3b74ced',
      '3342700b3fa4baa5a287d4fff9039505f75171b044de8f6947739280884993ba',
    ],
    'test/certification/fixtures/contract-manifest/golden.v1.json': [
      'a1bca7679febd33ce76a4a201b7bb2205afa8d1e068e0e036ff9ecff8015663c',
      'c87926dbb78033e15f505dac246989db01a77e5dc309860496d3c7e5a5aa13c9',
      '5d9656261eefc8c706eb07e0f8500a953044875f9f7e5b283e36741dd88890be',
    ],
    'test/certification/fixtures/contract-manifest/misplaced-runtime-field.v1.json': [
      'b89f8351ea0f3e07e5fe9564bc44a191153928e5aff96fb7183a18c984249ef5',
    ],
    'test/certification/fixtures/contract-manifest/missing-inventory-hash.v1.json': [
      'ccf3aa9bd2990012bfeaa735373fcf86299f66483a718338986e7cf6fbab9b85',
    ],
    'test/certification/fixtures/contract-manifest/self-reference.v1.json': [
      '2e7e6745b8e57ff831076b9f94a140b7602aa60818b176100ea898d7001db962',
    ],
    'test/certification/presentation-contract-input-inventory.v1.json': [
      '940be09b944212119bc5387bb33db2b3cbc7141d11af4c72eaaa1a37e7e087ab',
      'db1aa3f728cc7c42214ad1b6cefb1b13b35c6509a6f484561fdd879ea2cfcedd',
    ],
    'test/certification/presentation-contract-manifest.v1.json': [
      '945c00e5d5cd2912c6faf90cba9b5e506762366e156f3f3d08e4364cee01cfd6',
      '289b9d4ed852f87c5aa886c42c6869077b94ea8e67fa8f0f7d4068ae6e15e21a',
      '99be5c413762c80fec940dd3491a3da6f1be5090c63e019da9017703c42f4b3f',
      '845b593794c4d9730a32fa625e86f5c96ff4f767c672540d9c4f65937c8eb282',
    ],
    'test/certification/security-case-catalog.v1.json': [
      '8d1faea273a1f3a63e18051f90f0391cc912dae620d466dfc093a31e32f576ca',
      'c96f15ab1471fb4d220c1b71f2ea1c43a343e8860ea3b7795ca3c018835fc327',
    ],
    'test/integration/contract-certification.test.mjs': [
      '520d1e983ef2eb4df7bb5ff1a27f2294dfa67629e417a288786a28377a6936ad',
      '5b78bcd7ede75fc7ee9ee0602960e948f5e8667edbc1f927435a1f3d984b179d',
      '281345d3e225fc8b6590c4eb95ffce93590d57038c1f5a6e9ea05c066bc606bc',
    ],
    'test/integration/evidence-writer.test.mjs': [
      '5667b411dbe5be3d04d8790700606135c5d08909fe529290a8d5342a2386a925',
      '0539882193b1fa13e866745bfd1e2548207c4d3491d6de8da4ab9386491bce4b',
    ],
    'test/integration/sceneboard-scene-recipe.test.mjs': [
      '597885b47123595616a7a21d0db8c20a4e6c159d4a0b4a6d4eb7a0e2011ade21',
    ],
    'test/security/sceneboard-api-fallback.test.mjs': [
      '49e8d7dd13b41f57764ee60ca024cadccc3c199294102148bc21860ff64a10e1',
    ],
    'test/security/sceneboard-api-module-boundaries.test.mjs': [
      '3694d737b533e704e70d427ef4e9957cec0af640d2e6526ebce76e1a6daa2d93',
    ],
    'test/security/sceneboard-artifact-composer.test.mjs': [
      'c54c57bda300623dbe5be158afe9ecff4f09668d339d1dfe2f29e5220b09855c',
    ],
    ['test/security/secret-' + 'canary.e2e.test.mjs']: [
      'd5eeefeffc01018fa11f49d0506a215b37015b4f1368f38e9b40f44f84227bae',
    ],
  }),
);

const removeApprovedSyntheticSource = (path, text) =>
  (approvedSyntheticSourceSha256.get(path) ?? []).includes(sha256(text)) ? '' : text;

const gitText = (args) => {
  const run = spawnSync('git', args, {
    cwd: root,
    env: createGitCertificationEnvironment(process.env),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (run.status !== 0 || containsSecretLikeMaterial(run.stderr ?? ''))
    throw new CertificationError('SECRET_SCAN_GIT_INVENTORY_FAILED');
  return run.stdout;
};

const scanRepositoryAuthority = () => {
  const violations = [];
  const scan = (authority, path, text) => {
    if (containsSecretLikeMaterial(removeApprovedSyntheticSource(path, text)))
      violations.push(`${authority}:${path}`);
  };
  const trackedPaths = gitText(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const path of trackedPaths) scan('tracked-worktree', path, readText(resolve(root, path)));
  const indexPaths = gitText(['ls-files', '--stage', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf('\t') + 1));
  for (const path of indexPaths) {
    const bytes =
      spawnSync('git', ['show', `:${path}`], {
        cwd: root,
        env: createGitCertificationEnvironment(process.env),
        encoding: null,
      }).stdout ?? Buffer.alloc(0);
    if (bytes.length <= 16 * 1024 * 1024 && !bytes.includes(0))
      scan('index', path, bytes.toString('utf8'));
  }
  const headPaths = gitText(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    .split('\0')
    .filter(Boolean);
  for (const path of headPaths) {
    const bytes =
      spawnSync('git', ['show', `HEAD:${path}`], {
        cwd: root,
        env: createGitCertificationEnvironment(process.env),
        encoding: null,
      }).stdout ?? Buffer.alloc(0);
    if (bytes.length <= 16 * 1024 * 1024 && !bytes.includes(0))
      scan('head', path, bytes.toString('utf8'));
  }
  for (const path of [
    'sceneboard-fe/public/downloads/sceneboard.zip',
    'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip',
  ]) {
    if (existsSync(resolve(root, path)))
      scan('archives', path, readFileSync(resolve(root, path)).toString('latin1'));
  }
  return {
    violations,
    trackedCount: trackedPaths.length,
    indexCount: indexPaths.length,
    headCount: headPaths.length,
  };
};

const collectTree = (directory, baseDirectory = directory) => {
  const values = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new CertificationError('ARTIFACT_TREE_SYMLINK');
    if (entry.isDirectory()) values.push(...collectTree(path, baseDirectory));
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      values.push({
        path: relative(baseDirectory, path).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    } else throw new CertificationError('ARTIFACT_TREE_UNSUPPORTED_ENTRY');
  }
  return values;
};

const certificationCase = (caseName, identity) => {
  const attemptId = identity.attemptId;
  if (caseName === 'security-live') {
    const path = process.env.SCENEBOARD_SECURITY_LIVE_EVIDENCE_JSON;
    if (!path)
      return {
        ...commandReport({
          exitCode: 1,
          stdout: '',
          stderr: '',
          skipped: false,
          secretDetected: false,
        }),
        status: 'BLOCKED',
        safeCode: 'SECURITY_LIVE_EVIDENCE_MISSING',
        completedAssertions: [],
      };
    const catalog = JSON.parse(
      readFileSync(resolve(root, 'test/certification/security-case-catalog.v1.json'), 'utf8'),
    );
    const input = readOwnedCanonicalJsonInput(path, 'SECURITY_LIVE_EVIDENCE_INVALID');
    const validated = validateSecurityLiveEvidence(catalog, input.value, identity, input.bytes, {
      producerKey: process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY,
    });
    return {
      ...commandReport(
        { exitCode: 0, stdout: '', stderr: '', skipped: false, secretDetected: false },
        validated.details,
      ),
      attachments: validated.attachments,
      safeCode: 'SECURITY_LIVE_EVIDENCE_VERIFIED',
      completedAssertions: [
        'exact-live-case-set',
        'every-live-case-pass',
        'exact-owned-fixture-clean',
      ],
    };
  }
  if (caseName === 'backup-restore')
    return commandReport(
      runProcess('node', ['--test', 'test/integration/backup-restore-certification.test.mjs']),
    );
  if (caseName === 'restore-live') {
    let environment;
    try {
      environment = createRestoreCertificationEnvironment(attemptId, process.env);
    } catch (error) {
      if (!(error instanceof CertificationError)) throw error;
      return {
        ...commandReport({
          exitCode: 1,
          stdout: '',
          stderr: error.code,
          skipped: false,
          secretDetected: false,
        }),
        status: 'BLOCKED',
        safeCode: error.code,
        completedAssertions: [],
      };
    }
    const run = runProcess(
      'node',
      ['scripts/sceneboard-retention-restore-drill.mjs', '--produce'],
      environment,
    );
    let evidence;
    if (run.exitCode === 0) {
      try {
        evidence = validateRestoreLiveReport(run.stdout, attemptId);
      } catch (error) {
        if (!(error instanceof CertificationError)) throw error;
        run.exitCode = 1;
        run.stderr = error.code;
      }
    }
    const report = commandReport(run, evidence ?? {});
    return {
      ...report,
      safeCode: report.status === 'PASS' ? 'RESTORE_LIVE_VERIFIED' : report.safeCode,
      completedAssertions:
        report.status === 'PASS'
          ? [
              'attempt-owned-backup',
              'quarantine-restore',
              'media-byte-integrity',
              'schema-projection',
              'restricted-operator',
              'zero-residue-cleanup',
            ]
          : [],
    };
  }
  if (caseName === 'database-boundary') {
    const staticAssertions = runProcess('node', [
      '--test',
      'test/integration/database-certification.test.mjs',
    ]);
    let liveBoundary;
    try {
      liveBoundary = runProcess(
        'node',
        ['scripts/certify-migration-027.mjs'],
        createMigrationCertificationEnvironment(attemptId, process.env),
      );
    } catch (error) {
      if (!(error instanceof CertificationError)) throw error;
      liveBoundary = {
        exitCode: 1,
        stdout: '',
        stderr: error.code,
        secretDetected: false,
        skipped: false,
      };
    }
    let liveEvidence;
    if (liveBoundary.exitCode === 0) {
      try {
        liveEvidence = validateDatabaseBoundaryReport(liveBoundary.stdout, attemptId);
      } catch (error) {
        if (!(error instanceof CertificationError)) throw error;
        liveBoundary.exitCode = 1;
        liveBoundary.stderr = error.code;
      }
    }
    const run = combineCommandRuns([staticAssertions, liveBoundary]);
    const report = commandReport(run, {
      schemaVersion: 1,
      attemptId,
      target: 'disposable-loopback-mysql',
      scenarios: liveEvidence?.scenarios ?? [],
      databaseOwnerSha256: liveEvidence?.databaseOwnerSha256 ?? null,
      terminalVersion: liveEvidence?.terminalVersion ?? null,
      cleanupStatus: liveEvidence?.cleanupStatus ?? 'BLOCKED',
      staticAssertionsStatus: staticAssertions.exitCode === 0 ? 'PASS' : 'BLOCKED',
      liveBoundaryStatus:
        liveBoundary.exitCode === 0 && liveEvidence !== undefined ? 'PASS' : 'BLOCKED',
    });
    return {
      ...report,
      safeCode: report.status === 'PASS' ? 'DATABASE_BOUNDARY_VERIFIED' : report.safeCode,
      completedAssertions:
        report.status === 'PASS'
          ? [
              'static-schema-sql-cli',
              'fresh',
              'bounded-restart',
              'resumable-audit',
              'terminal-projection',
              'adopt',
              'zero-residue-cleanup',
            ]
          : [],
    };
  }
  if (caseName === 'workspace-boundary')
    return commandReport(
      runProcess('node', ['--test', 'test/integration/workspace-boundaries.test.mjs']),
    );
  if (caseName === 'secret-scan') {
    const scan = scanRepositoryAuthority();
    const pass = scan.violations.length === 0;
    return {
      status: pass ? 'PASS' : 'FAIL',
      safeCode: pass ? 'SECRET_SCAN_VERIFIED' : 'SECRET_OR_PRIVATE_MATERIAL_FOUND',
      exitCode: pass ? 0 : 1,
      completedAssertions: pass
        ? ['tracked-worktree', 'index', 'head', 'command-output', 'evidence', 'archives']
        : [],
      details: scan,
      stdoutSha256: sha256(''),
      stderrSha256: sha256(''),
      stdoutBytes: 0,
      stderrBytes: 0,
    };
  }
  if (caseName === 'artifact-runtime-build') {
    const directory = resolve(root, 'packages/artifact-runtime/dist');
    if (!existsSync(directory))
      return {
        ...commandReport({
          exitCode: 1,
          stdout: '',
          stderr: '',
          skipped: false,
          secretDetected: false,
        }),
        status: 'BLOCKED',
        safeCode: 'ARTIFACT_RUNTIME_BUILD_MISSING',
      };
    const tree = collectTree(directory);
    return {
      ...commandReport(
        { exitCode: 0, stdout: '', stderr: '', skipped: false, secretDetected: false },
        { treeSha256: canonicalJsonSha256(tree), tree },
      ),
      completedAssertions: defaultAssertions,
    };
  }
  if (caseName === 'migration-027')
    return commandReport(
      runProcess(
        'node',
        ['scripts/certify-migration-027.mjs'],
        createMigrationCertificationEnvironment(attemptId),
      ),
    );
  if (caseName === 'browser-e2e') {
    const run = runProcess(
      'node',
      ['scripts/certify-export-browser-e2e.mjs'],
      createBrowserCertificationEnvironment(attemptId),
    );
    let details = {};
    try {
      details = JSON.parse(run.stdout);
    } catch {
      details = {};
    }
    let schemaValid = false;
    try {
      validateBrowserEvidence(details);
      schemaValid = true;
    } catch {
      schemaValid = false;
    }
    const scenarios = Array.isArray(details.scenarios) ? details.scenarios : [];
    const passed = scenarios.filter(({ status }) => status === 'PASS').map(({ id }) => id);
    const exact = canonicalJson(passed) === canonicalJson(BROWSER_SCENARIO_IDS);
    const cleanup = details.cleanupStatus === 'PASS';
    const base = commandReport(run, details);
    const declaredBlocked = details.status === 'BLOCKED' && !run.secretDetected;
    return {
      ...base,
      status:
        base.status === 'PASS' && exact && cleanup && schemaValid
          ? 'PASS'
          : declaredBlocked
            ? 'BLOCKED'
            : base.status === 'FAIL'
              ? 'FAIL'
              : 'BLOCKED',
      safeCode:
        base.status === 'PASS' && exact && cleanup && schemaValid
          ? 'BROWSER_SCENARIOS_VERIFIED'
          : 'BROWSER_SCENARIOS_INCOMPLETE',
      completedAssertions: exact && cleanup && schemaValid ? BROWSER_SCENARIO_IDS : passed,
    };
  }
  if (caseName === 'pdf-golden' || caseName === 'pptx-golden') {
    if (
      caseName === 'pdf-golden' &&
      !existsSync(process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE ?? '')
    )
      return {
        ...commandReport({
          exitCode: 1,
          stdout: '',
          stderr: '',
          skipped: false,
          secretDetected: false,
        }),
        status: 'BLOCKED',
        safeCode: 'PINNED_CHROMIUM_EXECUTABLE_NOT_CONFIGURED',
      };
    return commandReport(
      runProcess('npm', [
        'exec',
        '--workspace',
        'sceneboard-be',
        '--',
        'tsx',
        '--test',
        'test/exports/export-delivery.test.ts',
      ]),
    );
  }
  if (caseName === 'runtime-smoke')
    return commandReport(runProcess('npm', ['run', 'smoke:export-runtime']));
  if (caseName === 'local-helper') {
    const first = runProcess('npm', ['run', 'build', '--workspace', 'sceneboard-mcp']);
    if (first.exitCode !== 0 || first.skipped || first.secretDetected) return commandReport(first);
    return commandReport(runProcess('npm', ['run', 'check:sceneboard-plugin']));
  }
  if (caseName === 'traceability') {
    const details = createTraceabilityEvidence(identity);
    return {
      ...commandReport(
        { exitCode: 0, stdout: '', stderr: '', skipped: false, secretDetected: false },
        details,
      ),
      safeCode: 'TRACEABILITY_AUTHORITY_VERIFIED',
      completedAssertions: defaultAssertions,
    };
  }
  throw new CertificationError('CERTIFICATION_CASE_INVALID');
};

const validateManualReport = (identity) => {
  const path = process.env.SCENEBOARD_MANUAL_BROWSER_ACCEPTANCE_JSON;
  if (!path) return null;
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (process.getuid && before.uid !== BigInt(process.getuid())) ||
    (before.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  )
    invalidManualEvidence();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) invalidManualEvidence();
    return validateManualReportBytes(readFileSync(descriptor), identity);
  } finally {
    closeSync(descriptor);
  }
};

const defaultExecuteRow = async (row, identity) => {
  if (row.id === 'INT-AUTH-ORIGINS') {
    const paths = [
      process.env.SCENEBOARD_FRONTEND_ENV_JSON,
      process.env.SCENEBOARD_BACKEND_ENV_JSON,
      process.env.SCENEBOARD_RUNTIME_ENV_JSON,
    ];
    if (paths.some((path) => !path))
      return {
        ...commandReport({
          exitCode: 1,
          stdout: '',
          stderr: '',
          skipped: false,
          secretDetected: false,
        }),
        status: 'BLOCKED',
        safeCode: 'TARGET_TOPOLOGY_INPUTS_MISSING',
        completedAssertions: [],
      };
    const { verifyAuthOriginTopology } = await import('./verify-auth-origin-topology.mjs');
    const details = await verifyAuthOriginTopology({
      frontendPath: paths[0],
      backendPath: paths[1],
      runtimePath: paths[2],
      identity,
    });
    return {
      ...commandReport(
        { exitCode: 0, stdout: '', stderr: '', skipped: false, secretDetected: false },
        details,
      ),
      completedAssertions: row.requiredAssertions,
    };
  }
  if (row.id === 'MANUAL-BROWSER-ACCEPTANCE') {
    const report = validateManualReport(identity);
    return report
      ? {
          ...commandReport(
            { exitCode: 0, stdout: '', stderr: '', skipped: false, secretDetected: false },
            report,
          ),
          completedAssertions: row.requiredAssertions,
        }
      : {
          ...commandReport({
            exitCode: 1,
            stdout: '',
            stderr: '',
            skipped: false,
            secretDetected: false,
          }),
          status: 'BLOCKED',
          safeCode: 'MANUAL_BROWSER_ACCEPTANCE_MISSING',
          completedAssertions: [],
        };
  }
  if (row.id.startsWith('CERT-'))
    return certificationCase(row.args[1].slice('--case='.length), identity);
  const environment = createCertificationChildEnvironment(process.env, {
    allowedKeys: generalCommandEnvironmentKeys,
    overrides: row.id === 'PKG-FE-BUILD' ? { NODE_ENV: 'production' } : {},
  });
  return commandReport(runProcess(row.executable, row.args, environment));
};

const normalizeReport = (row, identity, report) => {
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'].includes(report.status))
    throw new CertificationError('CERTIFICATION_RESULT_INVALID');
  const { attachments: _attachments, ...serializableReport } = report;
  if (containsSecretLikeMaterial(canonicalJson(serializableReport)))
    throw new CertificationError('EVIDENCE_SECRET_CANARY_MATCH');
  const details = report.details ?? {};
  return {
    schemaVersion: 2,
    rowId: row.id,
    issue: 'I-53',
    command: row.command,
    package: row.package,
    surface: row.surface,
    identity,
    status: report.status,
    safeCode: report.safeCode,
    exitCode: report.exitCode,
    completedAssertions: report.completedAssertions,
    stdoutSha256: report.stdoutSha256,
    stderrSha256: report.stderrSha256,
    stdoutBytes: report.stdoutBytes,
    stderrBytes: report.stderrBytes,
    artifact: {
      schemaVersion: 1,
      kind: row.artifactKind,
      rowId: row.id,
      status: report.status,
      detailsSha256: canonicalJsonSha256(details),
      details,
    },
  };
};

export const produceAiExportCertification = async ({
  workspaceRoot = root,
  sourceCommit,
  profile = 'non-production',
  environment,
  attemptId = `attempt-${Date.now()}-${randomBytes(8).toString('hex')}`,
  executeRow = defaultExecuteRow,
} = {}) => {
  if (
    !/^[0-9a-f]{40}$/u.test(sourceCommit ?? '') ||
    profile !== 'non-production' ||
    !environmentValues.has(environment)
  )
    throw new CertificationError('CERTIFICATION_IDENTITY_INVALID');
  const manifest = createAiExportManifest();
  const manifestSha256 = aiExportManifestSha256();
  const identity = { sourceCommit, manifestSha256, profile, environment, attemptId };
  const writer = await CertificationEvidenceWriter.create({
    workspaceRoot,
    sourceCommit,
    manifestSha256,
    profile,
    attemptId,
  });
  await writer.writeManifest(writer.ownerToken, manifest);
  const records = [];
  for (const row of AI_EXPORT_REQUIRED_ROWS) {
    let report;
    try {
      report = await executeRow(row, identity);
    } catch (error) {
      report = {
        status: error instanceof CertificationError ? 'BLOCKED' : 'FAIL',
        safeCode:
          error instanceof CertificationError ? error.code : 'CERTIFICATION_ROW_EXECUTION_FAILED',
        exitCode: 1,
        completedAssertions: [],
        details: {},
        stdoutSha256: sha256(''),
        stderrSha256: sha256(''),
        stdoutBytes: 0,
        stderrBytes: 0,
      };
    }
    if (report.attachments !== undefined) {
      if (
        row.id !== 'CERT-SECURITY-LIVE' ||
        report.status !== 'PASS' ||
        !Array.isArray(report.attachments) ||
        report.attachments.length !== report.details.caseCount + 1
      ) {
        throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
      }
      const written = [];
      for (const attachment of report.attachments) {
        if (!Buffer.isBuffer(attachment.bytes) || attachment.mediaType !== 'application/json') {
          throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
        }
        written.push(
          await writer.writeAttachment(writer.ownerToken, attachment.bytes, attachment.mediaType),
        );
      }
      if (
        new Set(written.map(({ contentSha256 }) => contentSha256)).size !== written.length ||
        !written.some(({ contentSha256 }) => contentSha256 === report.details.leafInventorySha256)
      ) {
        throw new CertificationError('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
      }
    }
    const record = normalizeReport(row, identity, report);
    await writer.writeRecord(writer.ownerToken, record);
    records.push(record);
  }
  await writer.finalizePhase(writer.ownerToken, 'i53', {
    schemaVersion: 1,
    phase: 'i53',
    identity,
    recordIds: records.map(({ rowId }) => rowId),
    status: records.every(({ status }) => status === 'PASS')
      ? 'PASS'
      : records.some(({ status }) => status === 'FAIL')
        ? 'FAIL'
        : 'BLOCKED',
  });
  return { workspaceRoot, writer, identity, manifest, records };
};

const parseCli = (args) =>
  Object.fromEntries(
    args.map((argument) => {
      const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
      if (!match) throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
      return [match[1], match[2]];
    }),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const values = parseCli(process.argv.slice(2));
    if (values.case) {
      if (Object.keys(values).some((key) => !['case', 'attempt-id'].includes(key)))
        throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
      const report = certificationCase(values.case, {
        manifestSha256: aiExportManifestSha256(),
        attemptId: values['attempt-id'] ?? 'standalone',
      });
      process.stdout.write(`${canonicalJson(report)}\n`);
      if (report.status !== 'PASS') process.exitCode = 1;
    } else {
      if (
        Object.keys(values).some(
          (key) => !['source-commit', 'profile', 'environment', 'attempt-id'].includes(key),
        )
      )
        throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
      const produced = await produceAiExportCertification({
        sourceCommit: values['source-commit'],
        profile: values.profile,
        environment: values.environment,
        attemptId: values['attempt-id'],
      });
      const { finalizeAiExportCertification } =
        await import('./verify-ai-export-certification.mjs');
      const result = await finalizeAiExportCertification(produced);
      process.stdout.write(`${canonicalJson(result.rollup)}\n`);
      if (result.rollup.status !== 'PASS') process.exitCode = 1;
    }
  } catch (error) {
    const reason =
      error instanceof CertificationError ? error.code : 'AI_EXPORT_CERTIFICATION_FAILED';
    process.stdout.write(`${canonicalJson({ schemaVersion: 1, status: 'FAIL', reason })}\n`);
    process.exitCode = 1;
  }
}
