import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './lib/certification/canonical-json.mjs';

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
const expectedSharpVersion = '0.35.3';
const expectedLibvipsVersion = '8.18.3';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixturePath = (path) => resolve(fixtureRoot, path);

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

const collectAdvisories = () => {
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    stdout = error?.stdout;
  }
  if (typeof stdout !== 'string') throw new TypeError('MEDIA_NATIVE_AUDIT_UNAVAILABLE');
  const report = JSON.parse(stdout);
  const advisories = [];
  for (const [name, value] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of value.via ?? []) {
      if (typeof via === 'string') continue;
      advisories.push({
        id: via.url?.split('/').at(-1) ?? String(via.source),
        package: name,
        severity: via.severity,
        nodes: value.nodes ?? [],
        disposition:
          name === 'sharp' && (value.nodes ?? []).every((node) => node === 'node_modules/sharp')
            ? 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE'
            : 'EXISTING_NON_MEDIA_SCOPE',
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
  const { report, advisories } = collectAdvisories();
  const unresolved = advisories.filter(
    (entry) =>
      (entry.severity === 'high' || entry.severity === 'critical') &&
      entry.disposition !== 'TRANSITIVE_FRONTEND_ONLY_BACKEND_PIN_SAFE' &&
      entry.disposition !== 'EXISTING_NON_MEDIA_SCOPE',
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
