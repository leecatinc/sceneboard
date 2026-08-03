import { readFileSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_EXPORT_REQUIRED_ROWS,
  aiExportManifestSha256,
  createAiExportManifest,
  validateBrowserEvidence,
  validateRestoreLiveReport,
  validateTraceabilityEvidence,
  validateManualReportBytes,
} from './certify-ai-export-contracts.mjs';
import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  canonicalJsonSha256,
  containsSecretLikeMaterial,
  sha256,
} from './lib/certification/canonical-json.mjs';
import {
  evidenceTreeSha256ForAttempt,
  readPrivateRegularFile,
} from './lib/certification/evidence-writer.mjs';
import { assertOwnedDirectory, resolveOwnedChild } from './lib/certification/fixture-ownership.mjs';
import {
  securityImplementationIdentity,
  validateSecurityLiveAttachmentInventory,
} from './lib/certification/security-catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordKeys = [
  'schemaVersion',
  'rowId',
  'issue',
  'command',
  'package',
  'surface',
  'identity',
  'status',
  'safeCode',
  'exitCode',
  'completedAssertions',
  'stdoutSha256',
  'stderrSha256',
  'stdoutBytes',
  'stderrBytes',
  'artifact',
];
const identityKeys = ['sourceCommit', 'manifestSha256', 'profile', 'environment', 'attemptId'];
const artifactKeys = ['schemaVersion', 'kind', 'rowId', 'status', 'detailsSha256', 'details'];
const statuses = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED']);

const fail = (code) => {
  throw new CertificationError(code);
};
const equal = (left, right, code) => {
  if (canonicalJson(left) !== canonicalJson(right)) fail(code);
};
const isContained = (parent, child) => {
  const offset = relative(parent, child);
  return (
    offset !== '..' && !offset.startsWith(`..${sep}`) && !offset.startsWith('/') && offset !== ''
  );
};

const validateIdentity = (identity) => {
  assertExactKeys(identity, identityKeys, 'CERTIFICATION_IDENTITY_INVALID');
  if (
    !/^[0-9a-f]{40}$/u.test(identity.sourceCommit) ||
    identity.manifestSha256 !== aiExportManifestSha256() ||
    identity.profile !== 'non-production' ||
    !['development', 'test', 'staging'].includes(identity.environment) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.attemptId)
  )
    fail('CERTIFICATION_IDENTITY_INVALID');
};

export const resolveCanonicalAttemptRoot = async (workspaceRoot, identity) => {
  validateIdentity(identity);
  const workspace = await realpath(resolve(workspaceRoot));
  const certification = resolve(workspace, '.artifacts/certification');
  const attempt = resolveOwnedChild(
    certification,
    identity.sourceCommit,
    identity.manifestSha256,
    identity.profile,
    identity.attemptId,
  );
  if (!isContained(workspace, attempt)) fail('EVIDENCE_PATH_ESCAPE');
  for (const directory of [
    certification,
    resolveOwnedChild(certification, identity.sourceCommit),
    resolveOwnedChild(certification, identity.sourceCommit, identity.manifestSha256),
    resolveOwnedChild(
      certification,
      identity.sourceCommit,
      identity.manifestSha256,
      identity.profile,
    ),
    attempt,
  ])
    await assertOwnedDirectory(directory);
  if ((await realpath(attempt)) !== attempt) fail('EVIDENCE_PATH_ESCAPE');
  return attempt;
};

const readOwnedRegularJson = async (attemptRoot, path) => {
  const bytes = await readPrivateRegularFile(attemptRoot, path);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('EVIDENCE_NON_CANONICAL');
  }
  if (bytes.toString('utf8') !== `${canonicalJson(value)}\n`) fail('EVIDENCE_NON_CANONICAL');
  return { bytes, value };
};

const validateTopology = (details, identity, now) => {
  assertExactKeys(
    details,
    [
      'schemaVersion',
      'generatedAt',
      'expiresAt',
      'frontendOrigin',
      'apiOrigin',
      'runtimeOrigin',
      'appEnv',
      'frontendInputSha256',
      'backendInputSha256',
      'runtimeInputSha256',
      'identity',
      'target',
    ],
    'AUTH_TOPOLOGY_EVIDENCE_INVALID',
  );
  equal(details.identity, identity, 'AUTH_TOPOLOGY_TARGET_MISMATCH');
  assertExactKeys(details.target, ['kind', 'bindingSha256'], 'AUTH_TOPOLOGY_EVIDENCE_INVALID');
  const generatedAt = Date.parse(details.generatedAt);
  const expiresAt = Date.parse(details.expiresAt);
  if (
    details.schemaVersion !== 'auth-artifact-origin-evidence/v3' ||
    details.appEnv !== identity.environment ||
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    generatedAt > now ||
    expiresAt <= now ||
    expiresAt - generatedAt > 15 * 60 * 1_000 ||
    ![details.frontendInputSha256, details.backendInputSha256, details.runtimeInputSha256].every(
      (value) => /^[0-9a-f]{64}$/u.test(value),
    ) ||
    details.target.kind !== 'submitted-deployment-topology' ||
    details.target.bindingSha256 !==
      sha256(
        canonicalJson({
          identity,
          frontendOrigin: details.frontendOrigin,
          apiOrigin: details.apiOrigin,
          runtimeOrigin: details.runtimeOrigin,
          frontendInputSha256: details.frontendInputSha256,
          backendInputSha256: details.backendInputSha256,
          runtimeInputSha256: details.runtimeInputSha256,
        }),
      )
  )
    fail('AUTH_TOPOLOGY_EVIDENCE_EXPIRED_OR_MISMATCHED');
};

const validateSemanticArtifact = (row, definition, identity, now) => {
  const details = row.artifact.details;
  if (canonicalJsonSha256(details) !== row.artifact.detailsSha256)
    fail('CERTIFICATION_ARTIFACT_HASH_MISMATCH');
  if (definition.id === 'INT-AUTH-ORIGINS' && row.status === 'PASS')
    validateTopology(details, identity, now);
  if (definition.id === 'CERT-BROWSER-E2E' && row.status === 'PASS')
    validateBrowserEvidence(details);
  if (definition.id === 'CERT-SECRET-SCAN' && row.status === 'PASS') {
    if (!Array.isArray(details.violations) || details.violations.length !== 0)
      fail('SECRET_SCAN_SEMANTIC_MISMATCH');
  }
  if (definition.id === 'CERT-SECURITY-LIVE' && row.status === 'PASS') {
    const catalog = JSON.parse(
      readFileSync(resolve(root, 'test/certification/security-case-catalog.v1.json'), 'utf8'),
    );
    assertExactKeys(
      details,
      [
        'schemaVersion',
        'producerId',
        'producerKeyId',
        'producedAt',
        'expiresAt',
        'identitySha256',
        'catalogSha256',
        'status',
        'liveEvidenceStatus',
        'cleanupStatus',
        'caseCount',
        'caseSetSha256',
        'evidenceSetSha256',
        'leafInventorySha256',
        'implementationSetSha256',
      ],
      'SECURITY_LIVE_EVIDENCE_INVALID',
    );
    if (
      details.schemaVersion !== 2 ||
      details.status !== 'PASS' ||
      details.liveEvidenceStatus !== 'PASS' ||
      details.cleanupStatus !== 'PASS' ||
      details.identitySha256 !== sha256(canonicalJson(identity)) ||
      details.catalogSha256 !== sha256(`${canonicalJson(catalog)}\n`) ||
      details.caseCount !== catalog.cases.length ||
      details.caseSetSha256 !==
        sha256(
          canonicalJson(
            catalog.cases.map(({ caseId, evidenceRowId }) => ({ caseId, evidenceRowId })),
          ),
        ) ||
      ![details.evidenceSetSha256, details.leafInventorySha256].every((value) =>
        /^[0-9a-f]{64}$/u.test(value),
      ) ||
      details.implementationSetSha256 !==
        sha256(
          canonicalJson(
            catalog.cases.map((definition) => ({
              caseId: definition.caseId,
              implementationSha256: securityImplementationIdentity(definition).implementationSha256,
            })),
          ),
        )
    )
      fail('SECURITY_LIVE_EVIDENCE_INVALID');
  }
  if (definition.id === 'CERT-RESTORE-LIVE' && row.status === 'PASS') {
    validateRestoreLiveReport(canonicalJson(details), identity.attemptId, now);
  }
  if (definition.id === 'CERT-TRACEABILITY' && row.status === 'PASS')
    validateTraceabilityEvidence(details, identity);
  if (definition.id === 'MANUAL-BROWSER-ACCEPTANCE' && row.status === 'PASS') {
    validateManualReportBytes(Buffer.from(`${canonicalJson(details)}\n`), identity, now);
  }
};

const validateSecurityAttachments = async (attemptRoot, details, identity, now) => {
  const attachmentsRoot = resolve(attemptRoot, 'attachments');
  const inventoryBytes = await readPrivateRegularFile(
    attemptRoot,
    resolveOwnedChild(attachmentsRoot, `${details.leafInventorySha256}.bin`),
  );
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString('utf8'));
  } catch {
    fail('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  }
  const hashes = [
    details.leafInventorySha256,
    ...(Array.isArray(inventory?.cases)
      ? inventory.cases.map(({ evidenceSha256 }) => evidenceSha256)
      : []),
  ];
  if (
    hashes.length !== details.caseCount + 1 ||
    new Set(hashes).size !== hashes.length ||
    hashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash))
  ) {
    fail('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  }
  const expectedNames = hashes.flatMap((hash) => [`${hash}.bin`, `${hash}.json`]).sort();
  const actualNames = (await readdir(attachmentsRoot)).sort();
  equal(actualNames, expectedNames, 'SECURITY_LIVE_ATTACHMENT_SET_INVALID');
  const leafBytesBySha256 = new Map();
  for (const hash of hashes) {
    const bytes = await readPrivateRegularFile(
      attemptRoot,
      resolveOwnedChild(attachmentsRoot, `${hash}.bin`),
    );
    const { value: metadata } = await readOwnedRegularJson(
      attemptRoot,
      resolveOwnedChild(attachmentsRoot, `${hash}.json`),
    );
    assertExactKeys(
      metadata,
      ['schemaVersion', 'contentSha256', 'byteLength', 'mediaType'],
      'SECURITY_LIVE_ATTACHMENT_SET_INVALID',
    );
    if (
      metadata.schemaVersion !== 1 ||
      metadata.contentSha256 !== hash ||
      metadata.byteLength !== bytes.length ||
      metadata.mediaType !== 'application/json' ||
      sha256(bytes) !== hash
    ) {
      fail('SECURITY_LIVE_ATTACHMENT_SET_INVALID');
    }
    if (hash !== details.leafInventorySha256) leafBytesBySha256.set(hash, bytes);
  }
  const catalog = JSON.parse(
    readFileSync(resolve(root, 'test/certification/security-case-catalog.v1.json'), 'utf8'),
  );
  validateSecurityLiveAttachmentInventory(
    catalog,
    details,
    identity,
    inventoryBytes,
    leafBytesBySha256,
    { producerKey: process.env.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY, now },
  );
};

const validateRecord = (row, definition, identity, now) => {
  assertExactKeys(row, recordKeys, 'CERTIFICATION_ROW_NOT_CLOSED');
  assertExactKeys(row.identity, identityKeys, 'CERTIFICATION_IDENTITY_INVALID');
  assertExactKeys(row.artifact, artifactKeys, 'CERTIFICATION_ARTIFACT_INVALID');
  equal(row.identity, identity, 'CERTIFICATION_MIXED_IDENTITY');
  if (
    row.schemaVersion !== 2 ||
    row.issue !== 'I-53' ||
    row.rowId !== definition.id ||
    row.command !== definition.command ||
    row.package !== definition.package ||
    row.surface !== definition.surface ||
    row.artifact.schemaVersion !== 1 ||
    row.artifact.kind !== definition.artifactKind ||
    row.artifact.rowId !== row.rowId ||
    row.artifact.status !== row.status ||
    !statuses.has(row.status) ||
    !/^[A-Z0-9][A-Z0-9._-]{0,127}$/u.test(row.safeCode) ||
    !Number.isInteger(row.exitCode) ||
    !Array.isArray(row.completedAssertions) ||
    new Set(row.completedAssertions).size !== row.completedAssertions.length ||
    ![row.stdoutSha256, row.stderrSha256, row.artifact.detailsSha256].every((value) =>
      /^[0-9a-f]{64}$/u.test(value),
    ) ||
    !Number.isSafeInteger(row.stdoutBytes) ||
    row.stdoutBytes < 0 ||
    !Number.isSafeInteger(row.stderrBytes) ||
    row.stderrBytes < 0
  )
    fail('CERTIFICATION_ROW_VALUE_INVALID');
  if (containsSecretLikeMaterial(canonicalJson(row))) fail('EVIDENCE_SECRET_CANARY_MATCH');
  if (row.status === 'PASS') {
    if (row.exitCode !== 0) fail('PASS_ROW_NONZERO_EXIT');
    equal(
      row.completedAssertions,
      definition.requiredAssertions,
      'CERTIFICATION_ASSERTION_SET_INCOMPLETE',
    );
  } else if (
    row.completedAssertions.some((value) => !definition.requiredAssertions.includes(value))
  ) {
    fail('CERTIFICATION_ASSERTION_SET_INVALID');
  }
  validateSemanticArtifact(row, definition, identity, now);
};

const readReleaseIndex = async (attemptRoot, identity, rollup, { required }) => {
  const path = resolve(attemptRoot, 'release-index.json');
  try {
    const { value } = await readOwnedRegularJson(attemptRoot, path);
    assertExactKeys(
      value,
      ['schemaVersion', 'issue', 'identity', 'rollup', 'evidenceTreeSha256'],
      'CERTIFICATION_RELEASE_INDEX_INVALID',
    );
    if (value.schemaVersion !== 2 || value.issue !== 'I-53')
      fail('CERTIFICATION_RELEASE_INDEX_INVALID');
    equal(value.identity, identity, 'CERTIFICATION_MIXED_IDENTITY');
    equal(value.rollup, rollup, 'CERTIFICATION_RELEASE_INDEX_INVALID');
    if (!/^[0-9a-f]{64}$/u.test(value.evidenceTreeSha256))
      fail('CERTIFICATION_RELEASE_INDEX_INVALID');
    if ((await evidenceTreeSha256ForAttempt(attemptRoot)) !== value.evidenceTreeSha256)
      fail('CERTIFICATION_EVIDENCE_TREE_MISMATCH');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') fail('CERTIFICATION_RELEASE_INDEX_MISSING');
    throw error;
  }
};

const verifyAiExportCertificationState = async ({
  workspaceRoot = root,
  identity,
  now = Date.now(),
  requireFinalized,
} = {}) => {
  const attemptRoot = await resolveCanonicalAttemptRoot(workspaceRoot, identity);
  const attemptEntries = (await readdir(attemptRoot)).sort();
  const expectedAttemptEntries = [
    '.owner.json',
    'attachments',
    'exclusions',
    'manifest.json',
    'phases',
    'records',
    ...(attemptEntries.includes('release-index.json') ? ['release-index.json'] : []),
  ].sort();
  equal(attemptEntries, expectedAttemptEntries, 'CERTIFICATION_ATTEMPT_SET_NOT_CLOSED');
  const { value: owner } = await readOwnedRegularJson(
    attemptRoot,
    resolve(attemptRoot, '.owner.json'),
  );
  assertExactKeys(
    owner,
    ['schemaVersion', 'ownerClass', 'ownerTokenSha256'],
    'CERTIFICATION_OWNER_INVALID',
  );
  if (
    owner.schemaVersion !== 1 ||
    owner.ownerClass !== 'D9-certification-evidence' ||
    !/^[0-9a-f]{64}$/u.test(owner.ownerTokenSha256)
  )
    fail('CERTIFICATION_OWNER_INVALID');
  for (const directoryName of ['attachments', 'exclusions']) {
    const directory = resolve(attemptRoot, directoryName);
    await assertOwnedDirectory(directory);
    if (directoryName === 'exclusions' && (await readdir(directory)).length !== 0)
      fail('CERTIFICATION_ATTEMPT_SET_NOT_CLOSED');
  }
  const manifestPath = resolve(attemptRoot, 'manifest.json');
  const { bytes: manifestBytes, value: manifest } = await readOwnedRegularJson(
    attemptRoot,
    manifestPath,
  );
  equal(manifest, createAiExportManifest(), 'CERTIFICATION_MANIFEST_REDEFINED');
  if (sha256(manifestBytes) !== identity.manifestSha256)
    fail('CERTIFICATION_MANIFEST_HASH_MISMATCH');

  const recordsRoot = resolve(attemptRoot, 'records');
  await assertOwnedDirectory(recordsRoot);
  const names = await readdir(recordsRoot);
  const expectedNames = AI_EXPORT_REQUIRED_ROWS.map(({ id }) => `${id}.json`).sort();
  equal([...names].sort(), expectedNames, 'CERTIFICATION_ROW_SET_NOT_CLOSED');
  const records = [];
  for (const definition of AI_EXPORT_REQUIRED_ROWS) {
    const { value: row } = await readOwnedRegularJson(
      attemptRoot,
      resolveOwnedChild(recordsRoot, `${definition.id}.json`),
    );
    validateRecord(row, definition, identity, now);
    records.push(row);
  }
  const securityRecord = records.find(({ rowId }) => rowId === 'CERT-SECURITY-LIVE');
  if (securityRecord?.status === 'PASS')
    await validateSecurityAttachments(attemptRoot, securityRecord.artifact.details, identity, now);
  else if ((await readdir(resolve(attemptRoot, 'attachments'))).length !== 0)
    fail('CERTIFICATION_ATTEMPT_SET_NOT_CLOSED');
  const topologyDetails = records.find(({ rowId }) => rowId === 'INT-AUTH-ORIGINS')?.artifact
    .details;
  const browserDetails = records.find(({ rowId }) => rowId === 'CERT-BROWSER-E2E')?.artifact
    .details;
  if (
    topologyDetails?.target?.kind !== 'submitted-deployment-topology' ||
    browserDetails?.targetTopology?.kind !== 'isolated-loopback-browser-fixture' ||
    browserDetails.targetTopology.attemptId !== identity.attemptId
  )
    fail('CERTIFICATION_CROSS_SURFACE_TARGET_MISMATCH');

  const phaseRoot = resolve(attemptRoot, 'phases');
  await assertOwnedDirectory(phaseRoot);
  const phaseNames = await readdir(phaseRoot);
  equal(phaseNames, ['i53.json'], 'CERTIFICATION_PHASE_SET_NOT_CLOSED');
  const { value: phase } = await readOwnedRegularJson(attemptRoot, resolve(phaseRoot, 'i53.json'));
  assertExactKeys(
    phase,
    ['schemaVersion', 'phase', 'identity', 'recordIds', 'status'],
    'CERTIFICATION_PHASE_INVALID',
  );
  equal(phase.identity, identity, 'CERTIFICATION_MIXED_IDENTITY');
  if (phase.schemaVersion !== 1 || phase.phase !== 'i53') fail('CERTIFICATION_PHASE_INVALID');
  equal(
    phase.recordIds,
    AI_EXPORT_REQUIRED_ROWS.map(({ id }) => id),
    'CERTIFICATION_ROW_SET_NOT_CLOSED',
  );

  const blockers = records.filter(({ status }) => status !== 'PASS').map(({ rowId }) => rowId);
  const status =
    blockers.length === 0
      ? 'PASS'
      : records.some(({ status: value }) => value === 'FAIL')
        ? 'FAIL'
        : 'BLOCKED';
  if (phase.status !== status) fail('CERTIFICATION_PHASE_STATUS_MISMATCH');
  const rollup = {
    schemaVersion: 2,
    issue: 'I-53',
    rowId: 'CERT-ROLLUP',
    identity,
    status,
    blockers,
    requiredInputCount: AI_EXPORT_REQUIRED_ROWS.length,
    verifiedInputCount: records.length,
    securityImplementationSetSha256:
      records.find(({ rowId }) => rowId === 'CERT-SECURITY-LIVE')?.artifact.details
        .implementationSetSha256 ?? null,
    cleanupStatus: records.some(
      ({ rowId, status: value }) => rowId === 'CERT-BROWSER-E2E' && value !== 'PASS',
    )
      ? 'BLOCKED'
      : 'PASS',
    recordsSha256: canonicalJsonSha256(records),
  };
  const releaseIndex = await readReleaseIndex(attemptRoot, identity, rollup, {
    required: requireFinalized,
  });
  return { attemptRoot, records, rollup, releaseIndex };
};

export const verifyAiExportCertification = async (options = {}) =>
  verifyAiExportCertificationState({ ...options, requireFinalized: true });

const verifyAiExportCertificationBeforeFinalization = async (options) =>
  verifyAiExportCertificationState({ ...options, requireFinalized: false });

export const finalizeAiExportCertification = async ({ workspaceRoot = root, writer, identity }) => {
  const prefinalized = await verifyAiExportCertificationBeforeFinalization({
    workspaceRoot,
    identity,
  });
  await writer.finalizeRelease(writer.ownerToken, {
    schemaVersion: 2,
    issue: 'I-53',
    identity,
    rollup: prefinalized.rollup,
  });
  return verifyAiExportCertification({ workspaceRoot, identity });
};

const cliIdentity = (arguments_) => {
  const values = {};
  for (const argument of arguments_) {
    const match =
      /^--(source-commit|manifest-sha256|profile|environment|attempt-id)=([A-Za-z0-9._-]+)$/u.exec(
        argument,
      );
    if (!match || values[match[1]] !== undefined) fail('CERTIFICATION_ARGUMENT_INVALID');
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== 5) fail('CERTIFICATION_ARGUMENT_INVALID');
  return {
    sourceCommit: values['source-commit'],
    manifestSha256: values['manifest-sha256'],
    profile: values.profile,
    environment: values.environment,
    attemptId: values['attempt-id'],
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const identity = cliIdentity(process.argv.slice(2));
    const verified = await verifyAiExportCertification({ identity });
    process.stdout.write(`${canonicalJson(verified.rollup)}\n`);
    if (verified.rollup.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    const reason =
      error instanceof CertificationError
        ? error.code
        : 'AI_EXPORT_CERTIFICATION_VERIFICATION_FAILED';
    process.stdout.write(`${canonicalJson({ schemaVersion: 1, status: 'FAIL', reason })}\n`);
    process.exitCode = 1;
  }
}
