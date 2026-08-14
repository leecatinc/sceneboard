import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './lib/certification/canonical-json.mjs';
import { createNpmCertificationEnvironment } from './lib/certification/process-lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromBackend = createRequire(resolve(root, 'sceneboard-be/package.json'));
const sharp = requireFromBackend('sharp');
const lockPath = resolve(root, 'package-lock.json');
const manifestPath = resolve(root, 'test/certification/fixtures/media/manifest.v1.json');
const certificatePath = resolve(root, 'test/certification/media-native-certification.v1.json');
const fixtureRoot = resolve(root, 'test/certification/fixtures/media');
const migrationPath = resolve(
  root,
  'sceneboard-be/src/database/migrations/sql/021_d9_media_store.up.sql',
);
const projectionPath = resolve(
  root,
  'sceneboard-be/test/contracts/schema-projections/d9-media-store.json',
);
const licensePolicyPath = resolve(
  root,
  'test/certification/policy/dependency-license-policy.v1.json',
);
const advisoryPolicyPath = resolve(
  root,
  'test/certification/policy/dependency-advisory-policy.v1.json',
);
const expectedSharpVersion = '0.35.3';
const expectedLibvipsVersion = '8.18.3';
const approvedAdvisoryDispositions = new Set([
  'EXISTING_NON_MEDIA_SCOPE',
  'PPTX_UNUSED_TRANSITIVE_DEPENDENCY',
  'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE',
]);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isExactNodeSet = (actual, expected) =>
  actual.length === expected.length &&
  [...actual].sort().every((node, index) => node === [...expected].sort()[index]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixturePath = (path) => resolve(fixtureRoot, path);

const runtimeModulePattern = /\.(?:c|m)?js$/u;

export const inspectPptxRuntimeImports = (entryPath) => {
  if (typeof entryPath !== 'string' || !runtimeModulePattern.test(entryPath))
    throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_ENTRY_INVALID');
  const distributionRoot = dirname(entryPath);
  const runtimeFiles = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_ENUMERATION_FAILED');
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_SYMLINK');
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && runtimeModulePattern.test(entry.name)) runtimeFiles.push(path);
    }
  };
  visit(distributionRoot);
  const normalizedEntry = resolve(entryPath);
  if (runtimeFiles.length === 0 || !runtimeFiles.includes(normalizedEntry))
    throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_ENTRY_UNINSPECTED');
  const files = runtimeFiles.map((path) => {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_READ_FAILED');
    }
    const relativePath = relative(distributionRoot, path).split(sep).join('/');
    if (relativePath.length === 0 || relativePath.startsWith('../'))
      throw new TypeError('MEDIA_NATIVE_PPTX_RUNTIME_PATH_INVALID');
    return {
      path: relativePath,
      sha256: sha256(bytes),
      imageSizeImport: bytes.includes(Buffer.from('image-size')),
    };
  });
  return {
    entry: relative(distributionRoot, normalizedEntry).split(sep).join('/'),
    files,
    imageSizeRuntimeImport: files.some((file) => file.imageSizeImport),
  };
};

const encoderFor = (mime, pipeline) => {
  if (mime === 'image/png')
    return pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: false,
      palette: false,
      progressive: false,
    });
  if (mime === 'image/jpeg')
    return pipeline.jpeg({
      quality: 90,
      chromaSubsampling: '4:4:4',
      progressive: false,
      mozjpeg: false,
    });
  return pipeline.webp({
    quality: 90,
    alphaQuality: 100,
    lossless: false,
    nearLossless: false,
    smartSubsample: false,
  });
};

const canonicalize = async (bytes, mime) => {
  const pipeline = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: 40_000_000,
    pages: 1,
    animated: false,
    sequentialRead: true,
    autoOrient: true,
  });
  const metadata = await pipeline.metadata();
  if (metadata.width !== 3 || metadata.height !== 2 || (metadata.pages ?? 1) !== 1)
    throw new TypeError('MEDIA_NATIVE_GOLDEN_METADATA_MISMATCH');
  return encoderFor(mime, pipeline).toBuffer();
};

const fixtureDefinitions = [
  { id: 'png', mime: 'image/png', input: 'input/golden.png', output: 'output/golden.png' },
  {
    id: 'jpeg',
    mime: 'image/jpeg',
    input: 'input/golden.jpeg',
    output: 'output/golden.jpeg',
  },
  {
    id: 'webp',
    mime: 'image/webp',
    input: 'input/golden.webp',
    output: 'output/golden.webp',
  },
];

const createInput = async (mime) => {
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 192, 0, 0, 255, 128, 255, 255, 0, 255, 0, 255, 255, 64, 255, 0, 255,
    224,
  ]);
  let pipeline = sharp(pixels, { raw: { width: 3, height: 2, channels: 4 } }).withMetadata({
    comment: 'must-be-removed',
  });
  if (mime === 'image/png') pipeline = pipeline.png({ compressionLevel: 1 });
  else if (mime === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 72 });
  else pipeline = pipeline.webp({ quality: 71 });
  return pipeline.toBuffer();
};

const writeFixtures = async () => {
  mkdirSync(resolve(fixtureRoot, 'input'), { recursive: true });
  mkdirSync(resolve(fixtureRoot, 'output'), { recursive: true });
  const fixtures = [];
  for (const definition of fixtureDefinitions) {
    const input = await createInput(definition.mime);
    const output = await canonicalize(input, definition.mime);
    writeFileSync(fixturePath(definition.input), input);
    writeFileSync(fixturePath(definition.output), output);
    fixtures.push({
      ...definition,
      width: 3,
      height: 2,
      inputSha256: sha256(input),
      outputSha256: sha256(output),
    });
  }
  const manifest = {
    schemaVersion: 1,
    sharpVersion: expectedSharpVersion,
    libvipsVersion: expectedLibvipsVersion,
    constructorOptions: {
      failOn: 'warning',
      limitInputPixels: 40_000_000,
      pages: 1,
      animated: false,
      sequentialRead: true,
      autoOrient: true,
    },
    encoders: {
      'image/png': {
        compressionLevel: 9,
        adaptiveFiltering: false,
        palette: false,
        progressive: false,
      },
      'image/jpeg': {
        quality: 90,
        chromaSubsampling: '4:4:4',
        progressive: false,
        mozjpeg: false,
      },
      'image/webp': {
        quality: 90,
        alphaQuality: 100,
        lossless: false,
        nearLossless: false,
        smartSubsample: false,
      },
    },
    platforms: [
      { os: 'linux', cpu: 'x64', libc: 'glibc', minimumGlibc: '2.26', cpuFeature: 'SSE4.2' },
      { os: 'linux', cpu: 'arm64', libc: 'glibc', minimumGlibc: '2.26', cpuFeature: null },
    ],
    fixtures,
  };
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
};

const nativePackagesFor = (lock, cpu) => {
  const paths = [
    'sceneboard-be/node_modules/sharp',
    `sceneboard-be/node_modules/@img/sharp-linux-${cpu}`,
    `sceneboard-be/node_modules/@img/sharp-libvips-linux-${cpu}`,
  ];
  return paths.map((path) => {
    const value = lock.packages[path];
    if (
      value === undefined ||
      typeof value.version !== 'string' ||
      typeof value.integrity !== 'string' ||
      typeof value.license !== 'string'
    )
      throw new TypeError('MEDIA_NATIVE_OPTIONAL_PACKAGE_MISSING');
    return {
      path,
      version: value.version,
      integrity: value.integrity,
      license: value.license,
      disposition:
        value.license.includes('LGPL') || value.license.includes('Apache-2.0')
          ? 'ALLOWED_BY_INVENTORY_POLICY'
          : 'UNRESOLVED',
    };
  });
};

const validateAuditReport = (report) => {
  if (
    !isRecord(report) ||
    (report.error !== undefined && report.error !== null) ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  )
    throw new TypeError('MEDIA_NATIVE_AUDIT_INVALID');
  const counts = report.metadata.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  const severityRank = new Map(severities.map((severity, index) => [severity, index]));
  if (
    !severities.every(
      (severity) => Number.isSafeInteger(counts[severity]) && counts[severity] >= 0,
    ) ||
    !Number.isSafeInteger(counts.total) ||
    counts.total !== severities.reduce((total, severity) => total + counts[severity], 0) ||
    counts.total !== Object.keys(report.vulnerabilities).length
  )
    throw new TypeError('MEDIA_NATIVE_AUDIT_INVALID');
  for (const value of Object.values(report.vulnerabilities)) {
    if (
      !isRecord(value) ||
      !severities.includes(value.severity) ||
      !Array.isArray(value.via) ||
      value.via.length === 0 ||
      !value.via.every(
        (via) =>
          (typeof via === 'string' && via.trim() !== '') ||
          (isRecord(via) && severities.includes(via.severity)),
      ) ||
      !Array.isArray(value.nodes) ||
      !value.nodes.every((node) => typeof node === 'string')
    )
      throw new TypeError('MEDIA_NATIVE_AUDIT_INVALID');
    const emittedSeverity = value.via.reduce((highest, via) => {
      const severity = typeof via === 'string' ? value.severity : via.severity;
      return severityRank.get(severity) > severityRank.get(highest) ? severity : highest;
    }, 'info');
    if (emittedSeverity !== value.severity) throw new TypeError('MEDIA_NATIVE_AUDIT_INVALID');
  }
  return report;
};

const readAuditReport = () => {
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: root,
      env: createNpmCertificationEnvironment(process.env, { network: true }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    stdout = error?.stdout;
  }
  if (typeof stdout !== 'string') throw new TypeError('MEDIA_NATIVE_AUDIT_UNAVAILABLE');
  try {
    return validateAuditReport(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof TypeError && error.message === 'MEDIA_NATIVE_AUDIT_INVALID') throw error;
    throw new TypeError('MEDIA_NATIVE_AUDIT_INVALID');
  }
};

export const collectAdvisories = (
  policy,
  { pptxImageSizeUnused, imageSizeDependents, auditReport },
) => {
  if (
    policy.schemaVersion !== 1 ||
    policy.mode !== 'explicit-high-severity-dispositions' ||
    !Array.isArray(policy.entries) ||
    !Array.isArray(policy.transitiveEntries)
  )
    throw new TypeError('MEDIA_NATIVE_ADVISORY_POLICY_INVALID');
  const dispositions = new Map();
  for (const entry of policy.entries) {
    if (
      typeof entry?.id !== 'string' ||
      typeof entry?.package !== 'string' ||
      typeof entry?.disposition !== 'string' ||
      !approvedAdvisoryDispositions.has(entry.disposition) ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === '' ||
      !Array.isArray(entry.nodes) ||
      entry.nodes.length === 0 ||
      !entry.nodes.every((node) => typeof node === 'string' && node.trim() !== '') ||
      new Set(entry.nodes).size !== entry.nodes.length
    )
      throw new TypeError('MEDIA_NATIVE_ADVISORY_POLICY_INVALID');
    const key = `${entry.id}:${entry.package}`;
    if (dispositions.has(key)) throw new TypeError('MEDIA_NATIVE_ADVISORY_POLICY_DUPLICATE');
    dispositions.set(key, entry);
  }
  const transitiveDispositions = new Map();
  for (const entry of policy.transitiveEntries) {
    if (
      typeof entry?.via !== 'string' ||
      typeof entry?.package !== 'string' ||
      typeof entry?.disposition !== 'string' ||
      !approvedAdvisoryDispositions.has(entry.disposition) ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === '' ||
      !Array.isArray(entry.nodes) ||
      entry.nodes.length === 0 ||
      !entry.nodes.every((node) => typeof node === 'string' && node.trim() !== '') ||
      new Set(entry.nodes).size !== entry.nodes.length
    )
      throw new TypeError('MEDIA_NATIVE_ADVISORY_POLICY_INVALID');
    const key = `${entry.via}:${entry.package}`;
    if (transitiveDispositions.has(key))
      throw new TypeError('MEDIA_NATIVE_ADVISORY_POLICY_DUPLICATE');
    transitiveDispositions.set(key, entry);
  }
  const report = auditReport === undefined ? readAuditReport() : validateAuditReport(auditReport);
  const expectedImageSizeTopology =
    Array.isArray(imageSizeDependents) &&
    imageSizeDependents.length === 1 &&
    imageSizeDependents[0]?.path === 'node_modules/pptxgenjs' &&
    imageSizeDependents[0]?.version === '4.0.1';
  const advisories = [];
  const dispositionsByPackage = new Map();
  for (const [name, value] of Object.entries(report.vulnerabilities)) {
    for (const via of value.via) {
      if (typeof via === 'string') continue;
      const id = via.url?.split('/').at(-1) ?? String(via.source);
      const policyEntry = dispositions.get(`${id}:${name}`);
      const requestedDisposition = policyEntry?.disposition ?? 'UNRESOLVED';
      const disposition =
        !policyEntry || !isExactNodeSet(value.nodes, policyEntry.nodes)
          ? 'UNRESOLVED'
          : requestedDisposition === 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY' &&
              (name !== 'image-size' ||
                !pptxImageSizeUnused ||
                !expectedImageSizeTopology ||
                value.nodes.length === 0 ||
                !value.nodes.every((node) => node === 'node_modules/image-size'))
            ? 'UNRESOLVED'
            : requestedDisposition === 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE' &&
                (name !== 'sharp' ||
                  value.nodes.length === 0 ||
                  !value.nodes.every((node) => node === 'node_modules/sharp'))
              ? 'UNRESOLVED'
              : requestedDisposition;
      advisories.push({
        id,
        package: name,
        severity: via.severity,
        nodes: value.nodes,
        disposition,
      });
      const packageAdvisories = dispositionsByPackage.get(name) ?? [];
      packageAdvisories.push({ severity: via.severity, disposition });
      dispositionsByPackage.set(name, packageAdvisories);
    }
  }
  for (const [name, value] of Object.entries(report.vulnerabilities)) {
    for (const via of value.via) {
      if (typeof via !== 'string') continue;
      const upstreamDispositions = (dispositionsByPackage.get(via) ?? [])
        .filter((entry) => entry.severity === value.severity)
        .map((entry) => entry.disposition);
      const uniqueUpstreamDispositions = new Set(upstreamDispositions);
      const transitiveEntry = transitiveDispositions.get(`${via}:${name}`);
      const inheritedDisposition =
        upstreamDispositions.length > 0 &&
        uniqueUpstreamDispositions.size === 1 &&
        upstreamDispositions.every((entry) => approvedAdvisoryDispositions.has(entry)) &&
        transitiveEntry?.disposition === upstreamDispositions[0] &&
        isExactNodeSet(value.nodes, transitiveEntry.nodes)
          ? upstreamDispositions[0]
          : 'UNRESOLVED';
      const disposition =
        name === 'pptxgenjs' &&
        via === 'image-size' &&
        pptxImageSizeUnused &&
        expectedImageSizeTopology &&
        value.nodes.length > 0 &&
        value.nodes.every((node) => node === 'node_modules/pptxgenjs') &&
        upstreamDispositions.length > 0 &&
        upstreamDispositions.every((entry) => entry === 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY') &&
        transitiveEntry?.disposition === 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY' &&
        isExactNodeSet(value.nodes, transitiveEntry.nodes)
          ? 'PPTX_UNUSED_TRANSITIVE_DEPENDENCY'
          : name === 'pptxgenjs' && via === 'image-size'
            ? 'UNRESOLVED'
            : inheritedDisposition;
      advisories.push({
        id: `dependency:${via}`,
        package: name,
        severity: value.severity,
        nodes: value.nodes,
        disposition,
      });
    }
  }
  advisories.sort((left, right) =>
    `${left.id}:${left.package}`.localeCompare(`${right.id}:${right.package}`, 'en'),
  );
  return { report, advisories };
};

export const observeMediaNativeCertification = async () => {
  if (!existsSync(manifestPath)) throw new TypeError('MEDIA_NATIVE_MANIFEST_MISSING');
  if (
    sharp.versions.sharp !== expectedSharpVersion ||
    sharp.versions.vips !== expectedLibvipsVersion
  )
    throw new TypeError('MEDIA_NATIVE_VERSION_MISMATCH');
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  const licensePolicyBytes = readFileSync(licensePolicyPath);
  const licensePolicy = JSON.parse(licensePolicyBytes);
  const advisoryPolicyBytes = readFileSync(advisoryPolicyPath);
  const advisoryPolicy = JSON.parse(advisoryPolicyBytes);
  const pptxgenPath = requireFromBackend.resolve('pptxgenjs');
  const pptxRuntimeEvidence = inspectPptxRuntimeImports(pptxgenPath);
  const pptxImageSizeUnused = !pptxRuntimeEvidence.imageSizeRuntimeImport;
  const imageSizeDependents = Object.entries(lock.packages)
    .filter(([, value]) => value.dependencies?.['image-size'] !== undefined)
    .map(([path, value]) => ({ path, version: value.version }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const goldenResults = [];
  for (const fixture of manifest.fixtures) {
    const input = readFileSync(fixturePath(fixture.input));
    const expected = readFileSync(fixturePath(fixture.output));
    const actual = await canonicalize(input, fixture.mime);
    const pass =
      sha256(input) === fixture.inputSha256 &&
      sha256(expected) === fixture.outputSha256 &&
      actual.equals(expected);
    goldenResults.push({ id: fixture.id, verdict: pass ? 'PASS' : 'FAIL' });
  }
  const platforms = ['x64', 'arm64'].map((cpu) => {
    const packages = nativePackagesFor(lock, cpu);
    return {
      os: 'linux',
      cpu,
      libc: 'glibc',
      packages,
      verdict: packages.every((entry) => entry.disposition !== 'UNRESOLVED') ? 'PASS' : 'FAIL',
    };
  });
  const { report, advisories } = collectAdvisories(advisoryPolicy, {
    pptxImageSizeUnused,
    imageSizeDependents,
  });
  const unresolved = advisories.filter(
    (entry) =>
      (entry.severity === 'high' || entry.severity === 'critical') &&
      !approvedAdvisoryDispositions.has(entry.disposition),
  );
  const licensePolicyPass =
    Array.isArray(licensePolicy.classifications) &&
    licensePolicy.classifications.includes('permissive') &&
    licensePolicy.classifications.includes('reciprocal');
  const verdict =
    goldenResults.every((entry) => entry.verdict === 'PASS') &&
    platforms.every((entry) => entry.verdict === 'PASS') &&
    unresolved.length === 0 &&
    licensePolicyPass
      ? 'PASS'
      : 'FAIL';
  return {
    schemaVersion: 1,
    command: 'node scripts/certify-media-native-dependency.mjs',
    collectedAt: new Date().toISOString(),
    sharpVersion: sharp.versions.sharp,
    libvipsVersion: sharp.versions.vips,
    artifactDigests: {
      migration: sha256(readFileSync(migrationPath)),
      projection: sha256(readFileSync(projectionPath)),
      nativeManifest: sha256(manifestBytes),
    },
    rawReportSha256: sha256(Buffer.from(canonicalJson(report))),
    lockfileSha256: sha256(lockBytes),
    licensePolicy: {
      sha256: sha256(licensePolicyBytes),
      mode: licensePolicy.mode,
      allowedClassifications: licensePolicy.classifications,
      verdict: licensePolicyPass ? 'PASS' : 'FAIL',
    },
    advisoryPolicy: {
      sha256: sha256(advisoryPolicyBytes),
      mode: advisoryPolicy.mode,
      explicitDispositionCount: advisoryPolicy.entries.length,
      pptxImageSizeRuntimeImport: !pptxImageSizeUnused,
      pptxRuntimeEvidence,
      imageSizeDependents,
      verdict: unresolved.length === 0 ? 'PASS' : 'FAIL',
    },
    advisories,
    platforms,
    goldenResults,
    verdict,
  };
};

const write = process.argv.includes('--write');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== '--write'))
      throw new TypeError('MEDIA_NATIVE_ARGUMENT_INVALID');
    if (write) await writeFixtures();
    const observed = await observeMediaNativeCertification();
    if (write) {
      writeFileSync(certificatePath, `${canonicalJson(observed)}\n`);
      process.stdout.write(`${JSON.stringify({ verdict: 'UPDATED' })}\n`);
    } else {
      const expected = JSON.parse(readFileSync(certificatePath, 'utf8'));
      observed.collectedAt = expected.collectedAt;
      if (canonicalJson(observed) !== canonicalJson(expected))
        throw new TypeError('MEDIA_NATIVE_CERTIFICATE_STALE');
      process.stdout.write(`${JSON.stringify({ verdict: observed.verdict })}\n`);
      if (observed.verdict !== 'PASS') process.exitCode = 2;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        verdict: 'BLOCKED',
        reason: error instanceof Error ? error.message : 'MEDIA_NATIVE_CERTIFICATION_FAILED',
      })}\n`,
    );
    process.exitCode = 2;
  }
}
