import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  readJson,
  safeResult,
  sha256,
} from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(root, 'test/certification/dependency-inventory.v1.json');
const policyPath = resolve(root, 'test/certification/policy/dependency-license-policy.v1.json');
const lockfilePath = resolve(root, 'package-lock.json');
const workspaceManifestPaths = [
  'package.json',
  'sceneboard-mcp/package.json',
  'sceneboard-be/package.json',
  'sceneboard-fe/package.json',
  'packages/artifact-runtime/package.json',
  'packages/board-schema/package.json',
  'packages/board-sdk/package.json',
  'packages/board-ui/package.json',
];
const legacyMit = new Set(['busboy', 'khroma', 'seq-queue', 'streamsearch']);

const parseProfile = (argumentsList) => {
  const value =
    argumentsList
      .find((argument) => argument.startsWith('--profile='))
      ?.slice('--profile='.length) ?? 'static';
  if (value !== 'static' && value !== 'clean-tree')
    throw new CertificationError('DEPENDENCY_INSTALL_FAILED');
  return value;
};

const licenseOf = (name, value) => {
  if (typeof value.license === 'string') return [value.license, 'lockfile'];
  if (
    Array.isArray(value.licenses) &&
    value.licenses.every((entry) => typeof entry?.type === 'string')
  ) {
    return [value.licenses.map(({ type }) => type).join(' OR '), 'package-manifest'];
  }
  if (legacyMit.has(name)) return ['MIT', 'license-file'];
  return [null, 'unresolved'];
};

const classificationOf = (license) => {
  if (license === null) return 'unresolved';
  if (license.includes('LGPL')) return 'reciprocal';
  if (license.startsWith('CC-') || license.startsWith('CC0')) return 'content-notice';
  return 'permissive';
};

const packageNameFromPath = (path) => path.split('node_modules/').at(-1);

export const observeDependencyInventory = () => {
  const lockBytes = readFileSync(lockfilePath);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 3) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  const packageManifestSha256 = workspaceManifestPaths.map((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    return { path, sha256: sha256(readFileSync(absolute)) };
  });
  const entries = Object.entries(lock.packages)
    .filter(
      ([path, value]) => path.startsWith('node_modules/') && typeof value?.version === 'string',
    )
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, value]) => {
      const name = packageNameFromPath(path);
      const [license, licenseSource] = licenseOf(name, value);
      if (
        license === null ||
        typeof value.resolved !== 'string' ||
        typeof value.integrity !== 'string'
      ) {
        throw new CertificationError('LICENSE_AMBIGUOUS');
      }
      const resolved = new URL(value.resolved);
      if (
        resolved.protocol !== 'https:' ||
        resolved.hostname !== 'registry.npmjs.org' ||
        resolved.username !== '' ||
        resolved.password !== ''
      ) {
        throw new CertificationError('DEPENDENCY_REGISTRY_SOURCE_INVALID');
      }
      return {
        path,
        name,
        version: value.version,
        license,
        licenseSource,
        classification: classificationOf(license),
        resolved: value.resolved,
        integrity: value.integrity,
        optional: value.optional === true,
      };
    });
  return {
    schemaVersion: 1,
    registryHost: 'registry.npmjs.org',
    lockfileVersion: 3,
    lockfileSha256: sha256(lockBytes),
    packageManifestSha256,
    entries,
  };
};

export const verifyDependencies = async ({
  profile = 'static',
  lockValue,
  lockBytes: providedLockBytes,
  inventoryValue,
  inventoryBytes,
  policyValue,
} = {}) => {
  if (!existsSync(lockfilePath)) throw new CertificationError('LOCKFILE_ABSENT_OR_UNCOMMITTED');
  const [lockSource, inventorySource, policySource] = await Promise.all([
    lockValue ? null : readJson(lockfilePath),
    inventoryValue ? null : readJson(inventoryPath),
    policyValue ? null : readJson(policyPath),
  ]);
  const lockBytes = providedLockBytes ?? lockSource?.bytes;
  const lock = lockValue ?? lockSource?.value;
  const inventory = inventoryValue ?? inventorySource?.value;
  const policy = policyValue ?? policySource?.value;
  const effectiveInventoryBytes =
    inventoryBytes ?? inventorySource?.bytes ?? Buffer.from(`${JSON.stringify(inventory)}\n`);
  assertExactKeys(
    inventory,
    [
      'schemaVersion',
      'registryHost',
      'lockfileVersion',
      'lockfileSha256',
      'packageManifestSha256',
      'entries',
    ],
    'DEPENDENCY_TREE_MISMATCH',
  );
  assertExactKeys(
    policy,
    ['schemaVersion', 'mode', 'classifications', 'unresolvedResult', 'productionApproval'],
    'LICENSE_AMBIGUOUS',
  );
  if (inventory.schemaVersion !== 1 || inventory.registryHost !== 'registry.npmjs.org') {
    throw new CertificationError('DEPENDENCY_REGISTRY_SOURCE_INVALID');
  }
  if (
    lock.lockfileVersion !== 3 ||
    inventory.lockfileVersion !== 3 ||
    inventory.lockfileSha256 !== sha256(lockBytes)
  ) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (rootManifest.packageManager !== 'npm@10.9.3' || rootManifest.engines?.node !== '>=22') {
    throw new CertificationError('NODE_NPM_VERSION_MISMATCH');
  }
  const npmVersion = execFileSync('npm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (npmVersion !== '10.9.3' || Number(process.versions.node.split('.')[0]) < 22) {
    throw new CertificationError('NODE_NPM_VERSION_MISMATCH');
  }
  const lockWorkspacePaths = new Set(
    Object.keys(lock.packages)
      .filter(
        (path) =>
          path !== '' && !path.startsWith('node_modules/') && !path.includes('/node_modules/'),
      )
      .map((path) => `${path}/package.json`),
  );
  const manifests = workspaceManifestPaths;
  if (!workspaceManifestPaths.slice(1).every((path) => lockWorkspacePaths.has(path))) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  const recordedManifests = inventory.packageManifestSha256.map(({ path }) => path);
  if (JSON.stringify(manifests) !== JSON.stringify(recordedManifests)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  for (const record of inventory.packageManifestSha256) {
    assertExactKeys(record, ['path', 'sha256'], 'LOCKFILE_MANIFEST_MISMATCH');
    if (
      !existsSync(resolve(root, record.path)) ||
      sha256(readFileSync(resolve(root, record.path))) !== record.sha256
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
  }
  const external = Object.entries(lock.packages)
    .filter(
      ([path, value]) => path.startsWith('node_modules/') && typeof value?.version === 'string',
    )
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (external.length !== inventory.entries.length)
    throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
  const classifications = new Set(policy.classifications);
  for (const [index, [path, value]] of external.entries()) {
    const record = inventory.entries[index];
    assertExactKeys(
      record,
      [
        'path',
        'name',
        'version',
        'license',
        'licenseSource',
        'classification',
        'resolved',
        'integrity',
        'optional',
      ],
      'DEPENDENCY_TREE_MISMATCH',
    );
    const name = packageNameFromPath(path);
    const [license, licenseSource] = licenseOf(name, value);
    if (record.path !== path || record.name !== name || record.version !== value.version) {
      throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    }
    let resolved;
    try {
      resolved = new URL(record.resolved);
    } catch {
      throw new CertificationError('DEPENDENCY_REGISTRY_SOURCE_INVALID');
    }
    if (
      resolved.protocol !== 'https:' ||
      resolved.hostname !== inventory.registryHost ||
      resolved.username !== '' ||
      resolved.password !== '' ||
      value.resolved !== record.resolved
    ) {
      throw new CertificationError(
        resolved.username !== '' || resolved.password !== ''
          ? 'CREDENTIAL_URL_DETECTED'
          : 'DEPENDENCY_REGISTRY_SOURCE_INVALID',
      );
    }
    if (
      typeof record.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(record.integrity) ||
      record.integrity !== value.integrity
    ) {
      throw new CertificationError('DEPENDENCY_INTEGRITY_MISSING_OR_INVALID');
    }
    if (
      license === null ||
      record.license !== license ||
      record.licenseSource !== licenseSource ||
      record.classification !== classificationOf(license) ||
      !classifications.has(record.classification)
    ) {
      throw new CertificationError('LICENSE_AMBIGUOUS');
    }
    if (record.optional !== (value.optional === true))
      throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    if (!record.optional && !existsSync(resolve(root, record.path, 'package.json'))) {
      throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    }
  }
  if (profile === 'clean-tree') {
    throw new CertificationError(
      'DEPENDENCY_INSTALL_FAILED',
      'clean-tree acquisition requires an explicit isolated network gate',
    );
  }
  return safeResult('PASS', {
    profile,
    dependencyCount: inventory.entries.length,
    lockfileSha256: inventory.lockfileSha256,
    inventorySha256: sha256(effectiveInventoryBytes),
    registryHost: inventory.registryHost,
    npmVersion,
    nodeMajor: Number(process.versions.node.split('.')[0]),
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argumentsList = process.argv.slice(2);
    const specialArguments = argumentsList.filter(
      (argument) => argument === '--observe' || argument === '--write',
    );
    if (
      specialArguments.length > 1 ||
      argumentsList.some(
        (argument) =>
          !argument.startsWith('--profile=') && argument !== '--observe' && argument !== '--write',
      )
    ) {
      throw new CertificationError('DEPENDENCY_INSTALL_FAILED');
    }
    if (argumentsList.includes('--observe')) {
      process.stdout.write(`${canonicalJson(observeDependencyInventory())}\n`);
    } else if (argumentsList.includes('--write')) {
      const inventory = observeDependencyInventory();
      writeFileSync(inventoryPath, `${canonicalJson(inventory)}\n`, { mode: 0o644 });
      process.stdout.write(
        `${JSON.stringify(safeResult('UPDATED', { dependencyCount: inventory.entries.length }))}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify(await verifyDependencies({ profile: parseProfile(argumentsList) }))}\n`,
      );
    }
  } catch (error) {
    const code = error instanceof CertificationError ? error.code : 'DEPENDENCY_INSTALL_FAILED';
    process.stdout.write(`${JSON.stringify(safeResult('BLOCKED', { reason: code }))}\n`);
    process.exitCode = 2;
  }
}
