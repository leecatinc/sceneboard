import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  readJson,
  resolveInside,
  safeResult,
  sha256,
} from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(
  root,
  'test/certification/presentation-contract-input-inventory.v1.json',
);
const manifestPath = resolve(root, 'test/certification/presentation-contract-manifest.v1.json');
const releaseIndexPath = resolve(root, 'test/certification/presentation-release-index.v1.json');
const exclusionPath = resolve(root, 'test/certification/run-exclusion.amd-06.v1.json');
const releaseIndexRelative = 'test/certification/presentation-release-index.v1.json';
const manifestRelative = 'test/certification/presentation-contract-manifest.v1.json';
const inventoryRelative = 'test/certification/presentation-contract-input-inventory.v1.json';
const exclusionRelative = 'test/certification/run-exclusion.amd-06.v1.json';

const requirementIds = Array.from({ length: 16 }, (_, index) => `REQ-${118 + index}`);
const decisionIds = [
  'DEC-IMG-001',
  'DEC-SKILL-001',
  'DEC-ANALYTICS-001',
  'ADR-02',
  'ADR-03',
  'ADR-04',
];
const ownerBridge = [
  ['I-17', 'D1'],
  ['I-18', 'D3'],
  ['I-19', 'D6'],
  ['I-20', 'D5'],
  ['I-21', 'D5'],
  ['I-22', 'D5'],
  ['I-23', 'D5'],
  ['I-24', 'D9'],
  ['I-25', 'D9'],
  ['I-26', 'D5'],
  ['I-27', 'D2'],
  ['I-28', 'D2'],
  ['I-29', 'D3'],
  ['I-30', 'D2'],
  ['I-31', 'D2'],
  ['I-32', 'D5'],
  ['I-33', 'D5'],
  ['I-34', 'D5'],
  ['I-35', 'D1'],
  ['I-36', 'D7'],
  ['I-37', 'D9'],
  ['I-38', 'D5'],
  ['I-39', 'D7'],
  ['I-40', 'D6'],
  ['I-41', 'D6'],
  ['I-42', 'D3'],
  ['I-43', 'D5'],
  ['I-44', 'D9'],
].map(([issueId, boundaryOwner]) => ({ issueId, boundaryOwner }));
const boundaryOwners = new Set(Array.from({ length: 9 }, (_, index) => `D${index + 1}`));
const publisherKinds = new Set([
  'schema',
  'migration-registry',
  'migration-sql',
  'http-route',
  'mcp-tool',
  'skill-source',
  'skill-archive',
  'browser-scenario',
  'deterministic-evidence',
  'security-inventory',
  'exclusion-schema',
  'exclusion-record',
]);
const excludedCampaigns = ['database-capacity', 'multi-client-capacity', 'redis-loss-capacity'];
const infrastructurePublishers = new Set([
  'PUB-MANIFEST-SCHEMA',
  'PUB-EXCLUSION-SCHEMA',
  'PUB-EXCLUSION-RECORD',
  'PUB-MIGRATION-REGISTRY',
]);

const fail = (code, message = code) => {
  throw new CertificationError(code, message);
};
const equal = (left, right, code) => {
  if (canonicalJson(left) !== canonicalJson(right)) fail(code);
};
const unique = (values, code) => {
  if (new Set(values).size !== values.length) fail(code);
};
const assertStringArray = (value, code) => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string'))
    fail(code);
  unique(value, code);
};

const canonicalPublisherPath = async (path) => {
  if ([manifestRelative, inventoryRelative, releaseIndexRelative].includes(path))
    fail('PRESENTATION_MANIFEST_SELF_REFERENCE');
  const absolute = resolveInside(root, path, 'PRESENTATION_PATH_ALIAS');
  if (relative(root, absolute).split(sep).join('/') !== path) fail('PRESENTATION_PATH_ALIAS');
  let metadata;
  let actual;
  try {
    metadata = await stat(absolute);
    actual = await realpath(absolute);
  } catch {
    fail('PRESENTATION_INPUT_MISSING');
  }
  if (!metadata.isFile() || actual !== absolute) fail('PRESENTATION_PATH_ALIAS');
  return { absolute, bytes: await readFile(absolute) };
};

const validateExclusionRecord = (record) => {
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'status',
      'decisionId',
      'campaignIds',
      'provenance',
      'decisionProvenanceSha256',
      'runId',
      'timestamp',
      'reason',
      'attemptId',
    ],
    'PRESENTATION_EXCLUSION_INVALID',
  );
  if (
    record.schemaVersion !== 1 ||
    record.status !== 'excluded-by-user-current-run' ||
    record.decisionId !== 'AMD-06' ||
    record.provenance !== 'user-decision' ||
    !/^[0-9a-f]{64}$/u.test(record.decisionProvenanceSha256) ||
    typeof record.runId !== 'string' ||
    record.runId.length === 0 ||
    typeof record.attemptId !== 'string' ||
    record.attemptId.length === 0 ||
    typeof record.reason !== 'string' ||
    record.reason.length === 0 ||
    !Number.isFinite(Date.parse(record.timestamp))
  )
    fail('PRESENTATION_EXCLUSION_INVALID');
  equal(record.campaignIds, excludedCampaigns, 'PRESENTATION_EXCLUSION_CAMPAIGN_DRIFT');
  if (sha256(record.reason) !== record.decisionProvenanceSha256)
    fail('PRESENTATION_EXCLUSION_PROVENANCE_DRIFT');
};

export const validatePresentationInventory = async ({ inventoryValue, inventoryBytes } = {}) => {
  let inventory = inventoryValue;
  let bytes = inventoryBytes;
  if (!inventory) ({ value: inventory, bytes } = await readJson(inventoryPath));
  if (!bytes) bytes = Buffer.from(`${canonicalJson(inventory)}\n`);
  assertExactKeys(
    inventory,
    [
      'schemaVersion',
      'requirements',
      'decisions',
      'owners',
      'publishers',
      'evidence',
      'migrations',
      'exclusions',
      'releaseIndexPath',
    ],
    'PRESENTATION_INVENTORY_SCHEMA_INVALID',
  );
  if (
    inventory.schemaVersion !== 1 ||
    !Array.isArray(inventory.requirements) ||
    !Array.isArray(inventory.decisions) ||
    !Array.isArray(inventory.owners) ||
    !Array.isArray(inventory.publishers) ||
    !Array.isArray(inventory.evidence) ||
    !Array.isArray(inventory.migrations) ||
    !Array.isArray(inventory.exclusions) ||
    inventory.releaseIndexPath !== releaseIndexRelative
  )
    fail('PRESENTATION_INVENTORY_SCHEMA_INVALID');

  equal(
    inventory.requirements.map(({ requirementId }) => requirementId),
    requirementIds,
    'PRESENTATION_REQUIREMENT_SET_DRIFT',
  );
  equal(
    inventory.decisions.map(({ decisionId }) => decisionId),
    decisionIds,
    'PRESENTATION_DECISION_SET_DRIFT',
  );
  equal(inventory.owners, ownerBridge, 'PRESENTATION_OWNER_DRIFT');

  const ownerIds = new Set(ownerBridge.map(({ issueId }) => issueId));
  const ownerByIssue = new Map(ownerBridge.map((row) => [row.issueId, row.boundaryOwner]));
  const publisherIds = new Set();
  const publisherPaths = new Set();
  const materializedPublishers = [];
  for (const publisher of inventory.publishers) {
    assertExactKeys(
      publisher,
      ['publisherId', 'kind', 'ownerIssue', 'boundaryOwner', 'path'],
      'PRESENTATION_INVENTORY_SCHEMA_INVALID',
    );
    if (
      typeof publisher.publisherId !== 'string' ||
      publisherIds.has(publisher.publisherId) ||
      !publisherKinds.has(publisher.kind) ||
      !ownerIds.has(publisher.ownerIssue) ||
      !boundaryOwners.has(publisher.boundaryOwner) ||
      typeof publisher.path !== 'string' ||
      publisherPaths.has(publisher.path)
    )
      fail('PRESENTATION_PUBLISHER_ALIAS');
    publisherIds.add(publisher.publisherId);
    publisherPaths.add(publisher.path);
    const { bytes: publisherBytes } = await canonicalPublisherPath(publisher.path);
    materializedPublishers.push({ ...publisher, sha256: sha256(publisherBytes) });
  }
  const publisherById = new Map(materializedPublishers.map((row) => [row.publisherId, row]));

  const evidenceIds = new Set();
  const materializedEvidence = [];
  for (const evidence of inventory.evidence) {
    assertExactKeys(
      evidence,
      ['evidenceId', 'publisherId', 'ownerIssue', 'boundaryOwner'],
      'PRESENTATION_INVENTORY_SCHEMA_INVALID',
    );
    const publisher = publisherById.get(evidence.publisherId);
    if (excludedCampaigns.includes(evidence.evidenceId) || publisher?.kind === 'exclusion-record')
      fail('PRESENTATION_EXCLUSION_AS_PASS');
    if (
      typeof evidence.evidenceId !== 'string' ||
      evidenceIds.has(evidence.evidenceId) ||
      publisher === undefined ||
      !ownerIds.has(evidence.ownerIssue) ||
      !boundaryOwners.has(evidence.boundaryOwner)
    )
      fail('PRESENTATION_EVIDENCE_INVALID');
    evidenceIds.add(evidence.evidenceId);
    materializedEvidence.push({ ...evidence, status: 'PASS', sha256: publisher.sha256 });
  }

  const usedPublishers = new Set(infrastructurePublishers);
  for (const requirement of inventory.requirements) {
    assertExactKeys(
      requirement,
      ['requirementId', 'ownerIssues', 'publisherIds', 'evidenceIds'],
      'PRESENTATION_INVENTORY_SCHEMA_INVALID',
    );
    assertStringArray(requirement.ownerIssues, 'PRESENTATION_REQUIREMENT_OWNER_INVALID');
    assertStringArray(requirement.publisherIds, 'PRESENTATION_REQUIREMENT_PUBLISHER_INVALID');
    assertStringArray(requirement.evidenceIds, 'PRESENTATION_REQUIREMENT_EVIDENCE_INVALID');
    if (requirement.ownerIssues.some((issue) => !ownerIds.has(issue)))
      fail('PRESENTATION_REQUIREMENT_OWNER_INVALID');
    for (const publisherId of requirement.publisherIds) {
      if (!publisherIds.has(publisherId)) fail('PRESENTATION_REQUIREMENT_PUBLISHER_INVALID');
      usedPublishers.add(publisherId);
    }
    for (const evidenceId of requirement.evidenceIds)
      if (!evidenceIds.has(evidenceId)) fail('PRESENTATION_REQUIREMENT_EVIDENCE_INVALID');
  }

  for (const decision of inventory.decisions) {
    assertExactKeys(
      decision,
      ['decisionId', 'ownerIssue', 'boundaryOwner', 'canonicalPublisherId', 'evidenceIds'],
      'PRESENTATION_INVENTORY_SCHEMA_INVALID',
    );
    if (
      !ownerIds.has(decision.ownerIssue) ||
      ownerByIssue.get(decision.ownerIssue) !== decision.boundaryOwner ||
      !publisherIds.has(decision.canonicalPublisherId)
    )
      fail('PRESENTATION_DECISION_OWNER_DRIFT');
    assertStringArray(decision.evidenceIds, 'PRESENTATION_DECISION_EVIDENCE_INVALID');
    for (const evidenceId of decision.evidenceIds)
      if (!evidenceIds.has(evidenceId)) fail('PRESENTATION_DECISION_EVIDENCE_INVALID');
    usedPublishers.add(decision.canonicalPublisherId);
  }

  equal(
    inventory.migrations.map(({ version }) => version),
    Array.from({ length: 11 }, (_, index) => String(13 + index).padStart(3, '0')),
    'PRESENTATION_MIGRATION_SEQUENCE_DRIFT',
  );
  for (const migration of inventory.migrations) {
    assertExactKeys(migration, ['version', 'publisherId'], 'PRESENTATION_INVENTORY_SCHEMA_INVALID');
    const publisher = publisherById.get(migration.publisherId);
    if (
      publisher?.kind !== 'migration-sql' ||
      !publisher.path.split('/').at(-1).startsWith(`${migration.version}_`)
    )
      fail('PRESENTATION_MIGRATION_SEQUENCE_DRIFT');
    usedPublishers.add(migration.publisherId);
  }
  const registry = await readFile(
    resolve(root, 'sceneboard-be/src/database/migrations/registry.ts'),
    'utf8',
  );
  const actualPresentationVersions = [...registry.matchAll(/\bversion: '(\d{3})_/gu)]
    .map((match) => match[1])
    .filter((version) => Number(version) >= 13);
  equal(
    actualPresentationVersions,
    inventory.migrations.map(({ version }) => version),
    'PRESENTATION_MIGRATION_SEQUENCE_DRIFT',
  );

  if (inventory.exclusions.length !== 1) fail('PRESENTATION_EXCLUSION_INVALID');
  const exclusion = inventory.exclusions[0];
  assertExactKeys(
    exclusion,
    ['decisionId', 'status', 'recordPath', 'campaignIds'],
    'PRESENTATION_EXCLUSION_INVALID',
  );
  if (
    exclusion.decisionId !== 'AMD-06' ||
    exclusion.status !== 'excluded-by-user-current-run' ||
    exclusion.recordPath !== exclusionRelative
  )
    fail('PRESENTATION_EXCLUSION_INVALID');
  equal(exclusion.campaignIds, excludedCampaigns, 'PRESENTATION_EXCLUSION_CAMPAIGN_DRIFT');
  const { bytes: exclusionBytes, value: exclusionRecord } = await readJson(exclusionPath);
  validateExclusionRecord(exclusionRecord);
  equal(
    exclusionRecord.campaignIds,
    exclusion.campaignIds,
    'PRESENTATION_EXCLUSION_CAMPAIGN_DRIFT',
  );
  if (
    materializedEvidence.some(
      ({ evidenceId, status }) => status === 'PASS' && exclusion.campaignIds.includes(evidenceId),
    )
  )
    fail('PRESENTATION_EXCLUSION_AS_PASS');

  for (const evidence of inventory.evidence) usedPublishers.add(evidence.publisherId);
  if (
    materializedPublishers.some(({ publisherId }) => !usedPublishers.has(publisherId)) ||
    [...usedPublishers].some((publisherId) => !publisherIds.has(publisherId))
  )
    fail('PRESENTATION_PUBLISHER_ORPHAN');

  const requirements = inventory.requirements.map((row) => ({ ...row }));
  const decisions = inventory.decisions.map((row) => ({
    ...row,
    canonicalInputSha256: publisherById.get(row.canonicalPublisherId).sha256,
    releaseIndexPath: releaseIndexRelative,
  }));
  const exclusions = [
    {
      decisionId: exclusion.decisionId,
      status: exclusion.status,
      recordPath: exclusion.recordPath,
      recordSha256: sha256(exclusionBytes),
      attemptId: exclusionRecord.attemptId,
      campaignIds: exclusion.campaignIds,
    },
  ];
  return {
    manifest: {
      manifestVersion: 1,
      inputInventorySha256: sha256(bytes),
      requirements,
      decisions,
      owners: inventory.owners,
      publishers: materializedPublishers,
      evidence: materializedEvidence,
      exclusions,
    },
    exclusionRecord,
  };
};

export const validatePresentationManifestShape = (manifest) => {
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    if ('manifestSha256' in manifest || 'releaseIndexSha256' in manifest || 'attemptId' in manifest)
      fail('PRESENTATION_MANIFEST_SELF_REFERENCE');
  }
  assertExactKeys(
    manifest,
    [
      'manifestVersion',
      'inputInventorySha256',
      'requirements',
      'decisions',
      'owners',
      'publishers',
      'evidence',
      'exclusions',
    ],
    'PRESENTATION_MANIFEST_SCHEMA_INVALID',
  );
  if (
    manifest.manifestVersion !== 1 ||
    !/^[0-9a-f]{64}$/u.test(manifest.inputInventorySha256) ||
    !Array.isArray(manifest.requirements) ||
    !Array.isArray(manifest.decisions) ||
    !Array.isArray(manifest.owners) ||
    !Array.isArray(manifest.publishers) ||
    !Array.isArray(manifest.evidence) ||
    !Array.isArray(manifest.exclusions)
  )
    fail('PRESENTATION_MANIFEST_SCHEMA_INVALID');
};

const releaseIndexFor = (manifest, exclusionRecord) => {
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  return {
    schemaVersion: 1,
    manifestPath: manifestRelative,
    manifestSha256: sha256(manifestBytes),
    inputInventorySha256: manifest.inputInventorySha256,
    reducedAssurance: true,
    exclusion: {
      decisionId: 'AMD-06',
      status: 'excluded-by-user-current-run',
      recordPath: exclusionRelative,
      recordSha256: manifest.exclusions[0].recordSha256,
      attemptId: exclusionRecord.attemptId,
      campaignIds: excludedCampaigns,
    },
  };
};

export const verifyPresentationContractManifest = async ({
  manifestValue,
  manifestBytes,
  inventoryValue,
  inventoryBytes,
  releaseIndexValue,
  releaseIndexBytes,
} = {}) => {
  let manifest = manifestValue;
  let bytes = manifestBytes;
  if (!manifest) ({ value: manifest, bytes } = await readJson(manifestPath));
  if (!bytes) bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  validatePresentationManifestShape(manifest);
  const canonicalManifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  if (!Buffer.from(bytes).equals(canonicalManifestBytes))
    fail('PRESENTATION_MANIFEST_NON_CANONICAL');
  const observed = await validatePresentationInventory({ inventoryValue, inventoryBytes });
  equal(manifest, observed.manifest, 'PRESENTATION_MANIFEST_DRIFT');

  let releaseIndex = releaseIndexValue;
  let indexBytes = releaseIndexBytes;
  if (!releaseIndex)
    ({ value: releaseIndex, bytes: indexBytes } = await readJson(releaseIndexPath));
  if (!indexBytes) indexBytes = Buffer.from(`${canonicalJson(releaseIndex)}\n`);
  const expectedIndex = releaseIndexFor(manifest, observed.exclusionRecord);
  if (
    !releaseIndex.reducedAssurance ||
    !releaseIndex.exclusion?.recordSha256 ||
    releaseIndex.exclusion.recordSha256 !== manifest.exclusions[0].recordSha256
  )
    fail('PRESENTATION_EXCLUSION_HASH_MISSING');
  equal(releaseIndex, expectedIndex, 'PRESENTATION_RELEASE_INDEX_DRIFT');
  if (!Buffer.from(indexBytes).equals(Buffer.from(`${canonicalJson(releaseIndex)}\n`)))
    fail('PRESENTATION_RELEASE_INDEX_NON_CANONICAL');
  return safeResult('PASS', {
    manifestSha256: releaseIndex.manifestSha256,
    inventorySha256: manifest.inputInventorySha256,
    requirementCount: manifest.requirements.length,
    decisionCount: manifest.decisions.length,
    ownerCount: manifest.owners.length,
    publisherCount: manifest.publishers.length,
    evidenceCount: manifest.evidence.length,
    reducedAssurance: true,
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => argument !== '--write') || arguments_.length > 1)
      fail('PRESENTATION_MANIFEST_ARGUMENT_INVALID');
    if (arguments_.includes('--write')) {
      const observed = await validatePresentationInventory();
      const manifestBytes = `${canonicalJson(observed.manifest)}\n`;
      const releaseIndex = releaseIndexFor(observed.manifest, observed.exclusionRecord);
      await writeFile(manifestPath, manifestBytes, { mode: 0o644 });
      await writeFile(releaseIndexPath, `${canonicalJson(releaseIndex)}\n`, { mode: 0o644 });
      process.stdout.write(
        `${JSON.stringify(
          safeResult('UPDATED', {
            manifestSha256: releaseIndex.manifestSha256,
            publisherCount: observed.manifest.publishers.length,
          }),
        )}\n`,
      );
    } else {
      process.stdout.write(`${JSON.stringify(await verifyPresentationContractManifest())}\n`);
    }
  } catch (error) {
    const code =
      error instanceof CertificationError
        ? error.code
        : 'PRESENTATION_CONTRACT_CERTIFICATION_FAILED';
    process.stdout.write(`${JSON.stringify(safeResult('FAIL', { reason: code }))}\n`);
    process.exitCode = 1;
  }
}
