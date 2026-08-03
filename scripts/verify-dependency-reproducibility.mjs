import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { createNpmCertificationEnvironment } from './lib/certification/process-lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(root, 'test/certification/dependency-inventory.v1.json');
const legacyMit = new Set(['busboy', 'khroma', 'seq-queue', 'streamsearch']);
const supportedClassifications = ['permissive', 'content-notice', 'reciprocal'];
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const canonicalRootOverrides = {
  '@modelcontextprotocol/sdk': {
    zod: '3.25.76',
  },
  '@hono/node-server': '1.19.13',
  jose: '6.2.2',
};

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

const equalStringSets = (left, right) =>
  left.size === right.size && [...left].every((entry) => right.has(entry));

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const manifestLockSections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];

const validateManifestLockSection = (section, value) => {
  if (!isRecord(value)) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  if (section === 'peerDependenciesMeta') {
    for (const [name, metadata] of Object.entries(value)) {
      if (
        !packageNamePattern.test(name) ||
        !isRecord(metadata) ||
        Object.keys(metadata).length !== 1 ||
        typeof metadata.optional !== 'boolean'
      ) {
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      }
    }
    return;
  }
  for (const [name, version] of Object.entries(value)) {
    if (!packageNamePattern.test(name) || typeof version !== 'string' || version.length === 0) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
  }
};

const assertManifestLockSections = (manifest, lockRecord) => {
  if (!isRecord(lockRecord)) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  for (const section of manifestLockSections) {
    const manifestHasSection = Object.hasOwn(manifest, section);
    const lockHasSection = Object.hasOwn(lockRecord, section);
    if (manifestHasSection !== lockHasSection) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    if (!manifestHasSection) continue;
    validateManifestLockSection(section, manifest[section]);
    validateManifestLockSection(section, lockRecord[section]);
    if (canonicalJson(manifest[section]) !== canonicalJson(lockRecord[section])) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
  }
};

const effectiveDependencyPath = (lockPackages, parentPath, targetName) => {
  const candidates = [`${parentPath}/node_modules/${targetName}`];
  let cursor = parentPath;
  while (true) {
    const marker = cursor.lastIndexOf('/node_modules/');
    if (marker === -1) {
      candidates.push(`node_modules/${targetName}`);
      break;
    }
    cursor = cursor.slice(0, marker);
    candidates.push(`${cursor}/node_modules/${targetName}`);
  }
  const match = candidates.find((path) => {
    const record = lockPackages[path];
    return record !== undefined && packageNameFromPath(path) === targetName;
  });
  if (match === undefined) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  return match;
};

const assertRootOverrides = (overrides, lockPackages) => {
  if (!isRecord(overrides) || canonicalJson(overrides) !== canonicalJson(canonicalRootOverrides)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  const policies = [];
  for (const [scopeName, value] of Object.entries(overrides)) {
    if (!packageNamePattern.test(scopeName))
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    if (typeof value === 'string') {
      if (!exactVersionPattern.test(value))
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      policies.push({ parentName: null, targetName: scopeName, version: value });
      continue;
    }
    if (!isRecord(value) || Object.keys(value).length === 0)
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    for (const [targetName, version] of Object.entries(value)) {
      if (
        !packageNamePattern.test(targetName) ||
        typeof version !== 'string' ||
        !exactVersionPattern.test(version)
      ) {
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      }
      policies.push({ parentName: scopeName, targetName, version });
    }
  }

  for (const policy of policies) {
    if (policy.parentName === null) {
      const targets = Object.entries(lockPackages).filter(
        ([path, record]) =>
          path.includes('node_modules/') &&
          packageNameFromPath(path) === policy.targetName &&
          typeof record?.version === 'string',
      );
      if (targets.length !== 1 || targets[0][1].version !== policy.version) {
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      }
      continue;
    }

    const parents = Object.entries(lockPackages).filter(
      ([path, record]) =>
        path.includes('node_modules/') &&
        packageNameFromPath(path) === policy.parentName &&
        typeof record?.version === 'string',
    );
    if (parents.length !== 1) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    const [parentPath, parentRecord] = parents[0];
    const declaredTarget =
      parentRecord.dependencies?.[policy.targetName] ??
      parentRecord.optionalDependencies?.[policy.targetName];
    if (typeof declaredTarget !== 'string')
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    const targetPath = effectiveDependencyPath(lockPackages, parentPath, policy.targetName);
    if (lockPackages[targetPath]?.version !== policy.version) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
  }
};

const discoverWorkspaceManifests = (rootPath, rootManifest) => {
  if (!Array.isArray(rootManifest.workspaces))
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  const manifestPaths = [];
  for (const declaration of rootManifest.workspaces) {
    if (
      typeof declaration !== 'string' ||
      declaration.length === 0 ||
      declaration.startsWith('/') ||
      declaration.includes('\\') ||
      declaration.split('/').includes('..') ||
      (declaration.includes('*') && !declaration.endsWith('/*')) ||
      declaration.slice(0, -2).includes('*')
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    if (declaration.endsWith('/*')) {
      const directory = declaration.slice(0, -2);
      let entries;
      try {
        entries = readdirSync(resolve(rootPath, directory), { withFileTypes: true });
      } catch {
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      }
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name, 'en'),
      )) {
        const path = `${directory}/${entry.name}/package.json`;
        if (entry.isDirectory() && existsSync(resolve(rootPath, path))) manifestPaths.push(path);
      }
    } else {
      manifestPaths.push(`${declaration.replace(/\/$/u, '')}/package.json`);
    }
  }
  if (new Set(manifestPaths).size !== manifestPaths.length)
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');

  const names = new Set();
  return manifestPaths.map((path) => {
    const absolute = resolve(rootPath, path);
    if (!existsSync(absolute)) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    let value;
    try {
      value = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    if (
      typeof value.name !== 'string' ||
      !packageNamePattern.test(value.name) ||
      names.has(value.name)
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    names.add(value.name);
    return { path, directory: path.slice(0, -'/package.json'.length), name: value.name, value };
  });
};

const orderedManifestPaths = (rootPath, discovered) => {
  const paths = ['package.json', ...discovered.map(({ path }) => path)];
  const discoveredSet = new Set(paths);
  try {
    const existing = JSON.parse(
      readFileSync(resolve(rootPath, 'test/certification/dependency-inventory.v1.json'), 'utf8'),
    ).packageManifestSha256.map(({ path }) => path);
    if (
      existing.length === paths.length &&
      new Set(existing).size === existing.length &&
      equalStringSets(new Set(existing), discoveredSet)
    ) {
      return existing;
    }
  } catch {
    // 기존 인증서 순서를 사용할 수 없으면 워크스페이스 선언 순서로 고정한다.
  }
  return paths;
};

const validatePolicy = (policy) => {
  if (
    policy.schemaVersion !== 1 ||
    policy.mode !== 'inventory-only' ||
    policy.unresolvedResult !== 'LICENSE_AMBIGUOUS' ||
    policy.productionApproval !== false ||
    !Array.isArray(policy.classifications) ||
    policy.classifications.some((classification) => typeof classification !== 'string') ||
    new Set(policy.classifications).size !== policy.classifications.length ||
    !equalStringSets(new Set(policy.classifications), new Set(supportedClassifications))
  ) {
    throw new CertificationError('LICENSE_AMBIGUOUS');
  }
};

export const observeDependencyInventory = ({ rootPath = root } = {}) => {
  const lockBytes = readFileSync(resolve(rootPath, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 3) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  const rootManifest = JSON.parse(readFileSync(resolve(rootPath, 'package.json'), 'utf8'));
  const discovered = discoverWorkspaceManifests(rootPath, rootManifest);
  const packageManifestSha256 = orderedManifestPaths(rootPath, discovered).map((path) => {
    const absolute = resolve(rootPath, path);
    if (!existsSync(absolute)) throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    return { path, sha256: sha256(readFileSync(absolute)) };
  });
  const entries = Object.entries(lock.packages)
    .filter(([path, value]) => path.includes('node_modules/') && typeof value?.version === 'string')
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
        hasInstallScript: value.hasInstallScript === true,
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
  rootPath = root,
} = {}) => {
  const effectiveLockfilePath = resolve(rootPath, 'package-lock.json');
  const effectiveInventoryPath = resolve(
    rootPath,
    'test/certification/dependency-inventory.v1.json',
  );
  const effectivePolicyPath = resolve(
    rootPath,
    'test/certification/policy/dependency-license-policy.v1.json',
  );
  if (!existsSync(effectiveLockfilePath))
    throw new CertificationError('LOCKFILE_ABSENT_OR_UNCOMMITTED');
  const [lockSource, inventorySource, policySource] = await Promise.all([
    lockValue ? null : readJson(effectiveLockfilePath),
    inventoryValue ? null : readJson(effectiveInventoryPath),
    policyValue ? null : readJson(effectivePolicyPath),
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
    [
      'schemaVersion',
      'mode',
      'classifications',
      'unresolvedResult',
      'productionApproval',
      'installScriptApproval',
    ],
    'LICENSE_AMBIGUOUS',
  );
  validatePolicy(policy);
  if (!Array.isArray(policy.installScriptApproval))
    throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
  const approvedInstallScripts = new Set(
    policy.installScriptApproval.map((approval) => {
      assertExactKeys(approval, ['path', 'name', 'version'], 'DEPENDENCY_TREE_MISMATCH');
      if (
        typeof approval.path !== 'string' ||
        typeof approval.name !== 'string' ||
        typeof approval.version !== 'string'
      )
        throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
      return JSON.stringify([approval.path, approval.name, approval.version]);
    }),
  );
  if (approvedInstallScripts.size !== policy.installScriptApproval.length)
    throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
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
  const rootManifest = JSON.parse(readFileSync(resolve(rootPath, 'package.json'), 'utf8'));
  if (rootManifest.packageManager !== 'npm@10.9.3' || rootManifest.engines?.node !== '>=22') {
    throw new CertificationError('NODE_NPM_VERSION_MISMATCH');
  }
  assertRootOverrides(rootManifest.overrides, lock.packages);
  assertManifestLockSections(rootManifest, lock.packages['']);
  const discovered = discoverWorkspaceManifests(rootPath, rootManifest);
  const discoveredPaths = new Set(discovered.map(({ path }) => path));
  const lockWorkspacePaths = new Set(
    Object.keys(lock.packages)
      .filter(
        (path) =>
          path !== '' && !path.startsWith('node_modules/') && !path.includes('/node_modules/'),
      )
      .map((path) => `${path}/package.json`),
  );
  if (!equalStringSets(discoveredPaths, lockWorkspacePaths)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  if (!Array.isArray(inventory.packageManifestSha256)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  const recordedManifests = new Set();
  for (const record of inventory.packageManifestSha256) {
    assertExactKeys(record, ['path', 'sha256'], 'LOCKFILE_MANIFEST_MISMATCH');
    if (
      typeof record.path !== 'string' ||
      typeof record.sha256 !== 'string' ||
      recordedManifests.has(record.path)
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    recordedManifests.add(record.path);
  }
  const expectedRecordedManifests = new Set(['package.json', ...discoveredPaths]);
  if (!equalStringSets(recordedManifests, expectedRecordedManifests)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  for (const record of inventory.packageManifestSha256) {
    if (
      !existsSync(resolve(rootPath, record.path)) ||
      sha256(readFileSync(resolve(rootPath, record.path))) !== record.sha256
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
  }
  const discoveredNames = new Set(discovered.map(({ name }) => name));
  const linkedWorkspacePaths = new Set();
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || value?.link !== true) continue;
    if (
      typeof value.resolved !== 'string' ||
      !discoveredPaths.has(`${value.resolved}/package.json`)
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    linkedWorkspacePaths.add(`${value.resolved}/package.json`);
  }
  if (!equalStringSets(linkedWorkspacePaths, discoveredPaths)) {
    throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
  }
  for (const workspace of discovered) {
    const lockRecord = lock.packages[workspace.directory];
    const linkRecord = lock.packages[`node_modules/${workspace.name}`];
    if (
      lockRecord === undefined ||
      (lockRecord.name !== undefined && lockRecord.name !== workspace.name) ||
      linkRecord?.link !== true ||
      linkRecord.resolved !== workspace.directory
    ) {
      throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
    }
    assertManifestLockSections(workspace.value, lockRecord);
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const dependencies = workspace.value[section];
      if (dependencies === undefined) continue;
      if (
        dependencies === null ||
        typeof dependencies !== 'object' ||
        Array.isArray(dependencies)
      ) {
        throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
      }
      for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== 'string') throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
        if (version.startsWith('workspace:') && !discoveredNames.has(name)) {
          throw new CertificationError('LOCKFILE_MANIFEST_MISMATCH');
        }
      }
    }
  }
  const external = Object.entries(lock.packages)
    .filter(([path, value]) => path.includes('node_modules/') && typeof value?.version === 'string')
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
        'hasInstallScript',
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
    if (record.hasInstallScript !== (value.hasInstallScript === true))
      throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    if (record.hasInstallScript) {
      const approval = JSON.stringify([record.path, record.name, record.version]);
      if (!approvedInstallScripts.delete(approval))
        throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    }
    if (!record.optional && !existsSync(resolve(rootPath, record.path, 'package.json'))) {
      throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
    }
  }
  if (approvedInstallScripts.size !== 0) throw new CertificationError('DEPENDENCY_TREE_MISMATCH');
  if (profile === 'clean-tree') {
    throw new CertificationError(
      'DEPENDENCY_INSTALL_FAILED',
      'clean-tree acquisition requires an explicit isolated network gate',
    );
  }
  const npmVersion = execFileSync('npm', ['--version'], {
    cwd: rootPath,
    env: createNpmCertificationEnvironment(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (npmVersion !== '10.9.3' || Number(process.versions.node.split('.')[0]) < 22) {
    throw new CertificationError('NODE_NPM_VERSION_MISMATCH');
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
