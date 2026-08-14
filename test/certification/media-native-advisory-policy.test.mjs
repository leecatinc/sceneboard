import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectAdvisories,
  inspectPptxRuntimeImports,
} from '../../scripts/certify-media-native-dependency.mjs';

const policy = (entries, transitiveEntries = []) => ({
  schemaVersion: 1,
  mode: 'explicit-high-severity-dispositions',
  entries,
  transitiveEntries,
});

const entry = (id, packageName, disposition, nodes = [`node_modules/${packageName}`]) => ({
  id,
  package: packageName,
  disposition,
  nodes,
  reason: 'Reviewed test disposition.',
});

const transitiveEntry = (
  via,
  packageName,
  disposition,
  nodes = [`node_modules/${packageName}`],
) => ({
  via,
  package: packageName,
  disposition,
  nodes,
  reason: 'Reviewed test transitive disposition.',
});

const auditReport = ({
  id = 'GHSA-test-test-test',
  packageName = 'image-size',
  nodes = [`node_modules/${packageName}`],
  severity = 'high',
} = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    [packageName]: {
      name: packageName,
      severity,
      isDirect: false,
      via: [
        {
          source: 1,
          name: packageName,
          dependency: packageName,
          title: 'Synthetic advisory',
          url: `https://github.com/advisories/${id}`,
          severity,
          range: '*',
        },
      ],
      effects: [],
      range: '*',
      nodes,
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: severity === 'moderate' ? 1 : 0,
      high: severity === 'high' ? 1 : 0,
      critical: severity === 'critical' ? 1 : 0,
      total: 1,
    },
  },
});

const evidence = (overrides = {}) => ({
  pptxImageSizeUnused: true,
  imageSizeDependents: [{ path: 'node_modules/pptxgenjs', version: '4.0.1' }],
  ...overrides,
});

const stringViaAuditReport = ({
  packageName = 'pptxgenjs',
  via = 'image-size',
  nodes = [`node_modules/${packageName}`],
  severity = 'high',
} = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    [packageName]: {
      name: packageName,
      severity,
      isDirect: false,
      via: [via],
      effects: [],
      range: '*',
      nodes,
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: severity === 'moderate' ? 1 : 0,
      high: severity === 'high' ? 1 : 0,
      critical: severity === 'critical' ? 1 : 0,
      total: 1,
    },
  },
});

test('pptx runtime inspection binds the resolved entry and nested executable modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sceneboard-pptx-runtime-'));
  try {
    const entryPath = join(directory, 'index.cjs');
    await writeFile(entryPath, 'module.exports = {};\n');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'loader.mjs'), "import sizeOf from 'image-size';\n");
    await writeFile(join(directory, 'ignored.map'), 'image-size');
    const evidence = inspectPptxRuntimeImports(entryPath);
    assert.equal(evidence.entry, 'index.cjs');
    assert.deepEqual(
      evidence.files.map(({ path }) => path),
      ['index.cjs', 'nested/loader.mjs'],
    );
    assert.equal(evidence.imageSizeRuntimeImport, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pptx runtime inspection fails closed for missing, unsupported, and unsafe entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sceneboard-pptx-runtime-invalid-'));
  try {
    const runtimePath = join(directory, 'runtime.js');
    await writeFile(runtimePath, 'module.exports = {};\n');
    assert.throws(
      () => inspectPptxRuntimeImports(join(directory, 'missing.js')),
      /MEDIA_NATIVE_PPTX_RUNTIME_ENTRY_UNINSPECTED/u,
    );
    assert.throws(
      () => inspectPptxRuntimeImports(join(directory, 'runtime.txt')),
      /MEDIA_NATIVE_PPTX_RUNTIME_ENTRY_INVALID/u,
    );
    assert.throws(
      () => inspectPptxRuntimeImports(join(directory, 'missing', 'entry.js')),
      /MEDIA_NATIVE_PPTX_RUNTIME_ENUMERATION_FAILED/u,
    );
    await symlink('runtime.js', join(directory, 'linked.js'));
    assert.throws(
      () => inspectPptxRuntimeImports(runtimePath),
      /MEDIA_NATIVE_PPTX_RUNTIME_SYMLINK/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('media advisory collection rejects JSON error and incomplete audit reports', () => {
  const missingVia = auditReport();
  missingVia.vulnerabilities['image-size'].via = [];
  const severityMismatch = auditReport();
  severityMismatch.vulnerabilities['image-size'].via[0].severity = 'moderate';
  for (const report of [
    { auditReportVersion: 2, error: { code: 'EAUDITNOLOCK' } },
    { auditReportVersion: 2, vulnerabilities: {}, metadata: {} },
    missingVia,
    severityMismatch,
  ])
    assert.throws(
      () => collectAdvisories(policy([]), evidence({ auditReport: report })),
      /MEDIA_NATIVE_AUDIT_INVALID/u,
    );
});

test('media advisory policy rejects invalid and duplicate dispositions', () => {
  const approved = entry('GHSA-test-test-test', 'image-size', 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY');
  assert.throws(
    () => collectAdvisories(policy([approved, approved]), evidence({ auditReport: auditReport() })),
    /MEDIA_NATIVE_ADVISORY_POLICY_DUPLICATE/u,
  );
  assert.throws(
    () =>
      collectAdvisories(
        policy([{ ...approved, disposition: 'ALLOW_EVERYTHING' }]),
        evidence({ auditReport: auditReport() }),
      ),
    /MEDIA_NATIVE_ADVISORY_POLICY_INVALID/u,
  );
});

test('unknown, topology-changed, and runtime-used image-size advisories fail closed', () => {
  const report = auditReport();
  assert.equal(
    collectAdvisories(policy([]), evidence({ auditReport: report })).advisories[0].disposition,
    'UNRESOLVED',
  );
  const approved = policy([
    entry('GHSA-test-test-test', 'image-size', 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY'),
  ]);
  for (const changedEvidence of [
    { pptxImageSizeUnused: false },
    {
      imageSizeDependents: [
        { path: 'node_modules/pptxgenjs', version: '4.0.1' },
        { path: 'node_modules/other-media-reader', version: '1.0.0' },
      ],
    },
  ])
    assert.equal(
      collectAdvisories(approved, evidence({ ...changedEvidence, auditReport: report }))
        .advisories[0].disposition,
      'UNRESOLVED',
    );
  assert.equal(
    collectAdvisories(approved, evidence({ auditReport: report })).advisories[0].disposition,
    'PPTX_UNUSED_TRANSITIVE_DEPENDENCY',
  );
});

test('frontend sharp disposition requires the exact package and a non-empty root node set', () => {
  const id = 'GHSA-sharp-test-test';
  const approved = policy([entry(id, 'sharp', 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE')]);
  for (const nodes of [[], ['sceneboard-be/node_modules/sharp']])
    assert.equal(
      collectAdvisories(
        approved,
        evidence({ auditReport: auditReport({ id, packageName: 'sharp', nodes }) }),
      ).advisories[0].disposition,
      'UNRESOLVED',
    );
  assert.equal(
    collectAdvisories(
      approved,
      evidence({
        auditReport: auditReport({ id, packageName: 'sharp', nodes: ['node_modules/sharp'] }),
      }),
    ).advisories[0].disposition,
    'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE',
  );
});

test('non-media dispositions require the exact reviewed audit topology', () => {
  const id = 'GHSA-postcss-test-test';
  const approved = policy([entry(id, 'postcss', 'EXISTING_NON_MEDIA_SCOPE')]);
  assert.equal(
    collectAdvisories(
      approved,
      evidence({ auditReport: auditReport({ id, packageName: 'postcss' }) }),
    ).advisories[0].disposition,
    'EXISTING_NON_MEDIA_SCOPE',
  );
  assert.equal(
    collectAdvisories(
      approved,
      evidence({
        auditReport: auditReport({
          id,
          packageName: 'postcss',
          nodes: ['sceneboard-be/node_modules/postcss'],
        }),
      }),
    ).advisories[0].disposition,
    'UNRESOLVED',
  );
});

test('string-only high severity via entries are retained and fail closed', () => {
  const report = stringViaAuditReport();
  const advisories = collectAdvisories(policy([]), evidence({ auditReport: report })).advisories;
  assert.deepEqual(advisories, [
    {
      id: 'dependency:image-size',
      package: 'pptxgenjs',
      severity: 'high',
      nodes: ['node_modules/pptxgenjs'],
      disposition: 'UNRESOLVED',
    },
  ]);
});

test('string-only pptxgenjs via inherits disposition only from validated image-size evidence', () => {
  const upstream = auditReport();
  upstream.vulnerabilities.pptxgenjs = stringViaAuditReport().vulnerabilities.pptxgenjs;
  upstream.metadata.vulnerabilities.high = 2;
  upstream.metadata.vulnerabilities.total = 2;
  const approved = policy(
    [entry('GHSA-test-test-test', 'image-size', 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY')],
    [transitiveEntry('image-size', 'pptxgenjs', 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY')],
  );
  const collected = collectAdvisories(approved, evidence({ auditReport: upstream })).advisories;
  assert.equal(
    collected.find((advisory) => advisory.package === 'pptxgenjs')?.disposition,
    'PPTX_UNUSED_TRANSITIVE_DEPENDENCY',
  );
  assert.equal(
    collectAdvisories(
      approved,
      evidence({ pptxImageSizeUnused: false, auditReport: upstream }),
    ).advisories.find((advisory) => advisory.package === 'pptxgenjs')?.disposition,
    'UNRESOLVED',
  );
});

test('string-only dependency chains inherit one validated upstream disposition', () => {
  const upstream = auditReport({
    id: 'GHSA-sharp-test-test',
    packageName: 'sharp',
    nodes: ['node_modules/sharp'],
  });
  upstream.vulnerabilities.next = stringViaAuditReport({
    packageName: 'next',
    via: 'sharp',
    nodes: ['node_modules/next'],
  }).vulnerabilities.next;
  upstream.metadata.vulnerabilities.high = 2;
  upstream.metadata.vulnerabilities.total = 2;
  const approved = policy(
    [entry('GHSA-sharp-test-test', 'sharp', 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE')],
    [transitiveEntry('sharp', 'next', 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE')],
  );
  assert.equal(
    collectAdvisories(approved, evidence({ auditReport: upstream })).advisories.find(
      (advisory) => advisory.package === 'next',
    )?.disposition,
    'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE',
  );
});
