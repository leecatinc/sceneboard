import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  observeDependencyInventory,
  verifyDependencies,
} from '../../scripts/verify-dependency-reproducibility.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const lockBytes = await readFile(new URL('../../package-lock.json', import.meta.url));
const lock = JSON.parse(lockBytes.toString('utf8'));
const inventory = JSON.parse(
  await readFile(new URL('../certification/dependency-inventory.v1.json', import.meta.url), 'utf8'),
);
const policy = JSON.parse(
  await readFile(
    new URL('../certification/policy/dependency-license-policy.v1.json', import.meta.url),
    'utf8',
  ),
);
const fixtureRoot = new URL(
  '../certification/fixtures/dependency-reproducibility/',
  import.meta.url,
);

const verifyStaleLockAfterManifestMutation = async ({ path, mutate }) => {
  const testRoot = await mkdtemp(join(tmpdir(), 'sceneboard-stale-lock-'));
  try {
    for (const record of inventory.packageManifestSha256) {
      const source = await readFile(new URL(`../../${record.path}`, import.meta.url));
      const destination = join(testRoot, record.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    await writeFile(join(testRoot, 'package-lock.json'), lockBytes);
    const manifestPath = join(testRoot, path);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(manifestPath, manifestBytes);
    const changedInventory = clone(inventory);
    const record = changedInventory.packageManifestSha256.find((entry) => entry.path === path);
    assert(record);
    record.sha256 = sha256(manifestBytes);
    await assert.rejects(
      () =>
        verifyDependencies({
          profile: 'static',
          rootPath: testRoot,
          lockValue: lock,
          lockBytes,
          inventoryValue: changedInventory,
          inventoryBytes: Buffer.from(`${JSON.stringify(changedInventory)}\n`),
          policyValue: policy,
        }),
      (error) => error?.code === 'LOCKFILE_MANIFEST_MISMATCH',
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
};

test('committed public-registry dependency inventory matches the hydrated static tree', async () => {
  assert.deepEqual(observeDependencyInventory(), inventory);
  const result = await verifyDependencies({ profile: 'static' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.registryHost, 'registry.npmjs.org');
  assert.equal(result.dependencyCount, 615);
  assert.equal(result.npmVersion, '10.9.3');
  assert.ok(result.nodeMajor >= 22);
});

test('workspace-nested native dependencies preserve every certified field', async () => {
  const nestedPath = 'sceneboard-be/node_modules/sharp';
  const index = inventory.entries.findIndex(({ path }) => path === nestedPath);
  assert.notEqual(index, -1);
  for (const [field, mutate, expectedReason] of [
    [
      'registry',
      (entry) => {
        entry.resolved = entry.resolved.replace('registry.npmjs.org', 'packages.invalid');
      },
      'DEPENDENCY_REGISTRY_SOURCE_INVALID',
    ],
    [
      'integrity',
      (entry) => (entry.integrity = 'sha512-AAAA'),
      'DEPENDENCY_INTEGRITY_MISSING_OR_INVALID',
    ],
    ['license', (entry) => (entry.license = 'UNKNOWN'), 'LICENSE_AMBIGUOUS'],
    ['optional', (entry) => (entry.optional = !entry.optional), 'DEPENDENCY_TREE_MISMATCH'],
  ]) {
    const changed = clone(inventory);
    mutate(changed.entries[index]);
    await assert.rejects(
      () =>
        verifyDependencies({
          profile: 'static',
          lockValue: lock,
          lockBytes,
          inventoryValue: changed,
          inventoryBytes: Buffer.from(`${JSON.stringify(changed)}\n`),
        }),
      (error) => error?.code === expectedReason,
      field,
    );
  }
});

test('install-script additions and removals require an exact approved path, name, and version', async () => {
  for (const [path, enabled] of [
    ['sceneboard-be/node_modules/sharp', true],
    ['node_modules/esbuild', false],
  ]) {
    const changedLock = clone(lock);
    const changedInventory = clone(inventory);
    const inventoryEntry = changedInventory.entries.find((entry) => entry.path === path);
    assert(inventoryEntry);
    if (enabled) changedLock.packages[path].hasInstallScript = true;
    else delete changedLock.packages[path].hasInstallScript;
    inventoryEntry.hasInstallScript = enabled;
    const changedLockBytes = Buffer.from(JSON.stringify(changedLock));
    changedInventory.lockfileSha256 = sha256(changedLockBytes);
    await assert.rejects(
      () =>
        verifyDependencies({
          profile: 'static',
          lockValue: changedLock,
          lockBytes: changedLockBytes,
          inventoryValue: changedInventory,
          inventoryBytes: Buffer.from(`${JSON.stringify(changedInventory)}\n`),
        }),
      (error) => error?.code === 'DEPENDENCY_TREE_MISMATCH',
      `${path}:${enabled}`,
    );
  }
});

test('every v1 dependency policy field and classification boundary fails closed on drift', async () => {
  const mutations = [
    ['schema-version', (changed) => (changed.schemaVersion = 2)],
    ['schema-version-type', (changed) => (changed.schemaVersion = '1')],
    ['mode', (changed) => (changed.mode = 'approval')],
    ['mode-type', (changed) => (changed.mode = null)],
    ['unresolved-result', (changed) => (changed.unresolvedResult = 'PASS')],
    ['unresolved-result-type', (changed) => (changed.unresolvedResult = null)],
    ['production-approval', (changed) => (changed.productionApproval = true)],
    ['production-approval-type', (changed) => (changed.productionApproval = 'false')],
    ['classifications-type', (changed) => (changed.classifications = 'permissive')],
    ['classification-element-type', (changed) => changed.classifications.push(1)],
    ['classification-duplicate', (changed) => changed.classifications.push('permissive')],
    ['classification-added', (changed) => changed.classifications.push('unresolved')],
    ['classification-removed', (changed) => changed.classifications.pop()],
  ];
  for (const [name, mutate] of mutations) {
    const changed = clone(policy);
    mutate(changed);
    await assert.rejects(
      () =>
        verifyDependencies({
          profile: 'static',
          lockValue: lock,
          lockBytes,
          inventoryValue: inventory,
          inventoryBytes: Buffer.from(`${JSON.stringify(inventory)}\n`),
          policyValue: changed,
        }),
      (error) => error?.code === 'LICENSE_AMBIGUOUS',
      name,
    );
  }
});

test('a newly discovered workspace cannot be omitted from regenerated lock and inventory hashes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'sceneboard-dependency-workspaces-'));
  try {
    const manifestPaths = inventory.packageManifestSha256.map(({ path }) => path);
    for (const path of manifestPaths) {
      const source = await readFile(new URL(`../../${path}`, import.meta.url));
      const destination = join(fixtureRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    const unexpectedPath = 'packages/unexpected/package.json';
    await mkdir(dirname(join(fixtureRoot, unexpectedPath)), { recursive: true });
    await writeFile(
      join(fixtureRoot, unexpectedPath),
      `${JSON.stringify({ name: '@sceneboard/unexpected', version: '0.0.0' }, null, 2)}\n`,
    );

    const changedLock = clone(lock);
    changedLock.packages['packages/unexpected'] = {
      name: '@sceneboard/unexpected',
      version: '0.0.0',
    };
    changedLock.packages['node_modules/@sceneboard/unexpected'] = {
      resolved: 'packages/unexpected',
      link: true,
    };
    const changedLockBytes = Buffer.from(`${JSON.stringify(changedLock)}\n`);
    await writeFile(join(fixtureRoot, 'package-lock.json'), changedLockBytes);

    const changedInventory = clone(inventory);
    changedInventory.lockfileSha256 = sha256(changedLockBytes);
    for (const record of changedInventory.packageManifestSha256) {
      record.sha256 = sha256(await readFile(join(fixtureRoot, record.path)));
    }
    await assert.rejects(
      () =>
        verifyDependencies({
          profile: 'static',
          rootPath: fixtureRoot,
          lockValue: changedLock,
          lockBytes: changedLockBytes,
          inventoryValue: changedInventory,
          inventoryBytes: Buffer.from(`${JSON.stringify(changedInventory)}\n`),
          policyValue: policy,
        }),
      (error) => error?.code === 'LOCKFILE_MANIFEST_MISMATCH',
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('root and workspace manifest dependency maps must exactly match package-lock records', async (context) => {
  const mutations = [
    {
      name: 'root dependency addition',
      path: 'package.json',
      mutate: (manifest) => (manifest.dependencies['stale-lock-fixture'] = '1.0.0'),
    },
    {
      name: 'root dependency removal',
      path: 'package.json',
      mutate: (manifest) => delete manifest.dependencies.mermaid,
    },
    {
      name: 'root dependency version change',
      path: 'package.json',
      mutate: (manifest) => (manifest.dependencies.mermaid = '0.0.0'),
    },
    {
      name: 'workspace dependency addition',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => (manifest.dependencies['stale-lock-fixture'] = '1.0.0'),
    },
    {
      name: 'workspace dependency removal',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => delete manifest.dependencies['@sceneboard/board-schema'],
    },
    {
      name: 'workspace dependency version change',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => (manifest.dependencies['@sceneboard/board-schema'] = '9.9.9'),
    },
    {
      name: 'workspace protocol edge addition',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => (manifest.dependencies['@sceneboard/artifact-runtime'] = 'workspace:*'),
    },
    {
      name: 'optional dependency addition',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => (manifest.optionalDependencies = { 'stale-lock-fixture': '1.0.0' }),
    },
    {
      name: 'peer optional metadata addition',
      path: 'packages/board-ui/package.json',
      mutate: (manifest) => {
        manifest.peerDependencies = { 'stale-lock-fixture': '1.0.0' };
        manifest.peerDependenciesMeta = { 'stale-lock-fixture': { optional: true } };
      },
    },
  ];
  for (const mutation of mutations) {
    await context.test(mutation.name, () => verifyStaleLockAfterManifestMutation(mutation));
  }
});

test('dependency mutation fixtures preserve exact fail-closed reasons', async (context) => {
  const names = [
    'registry-host-drift.v1.json',
    'credential-url.v1.json',
    'integrity-drift.v1.json',
    'manifest-lock-mismatch.v1.json',
    'installed-tree-drift.v1.json',
  ];
  for (const name of names)
    await context.test(name, async () => {
      const fixture = JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'));
      const changed = clone(inventory);
      if (fixture.mutation === 'inventory-registry-host') changed.registryHost = 'packages.invalid';
      if (fixture.mutation === 'inventory-first-resolved-credential') {
        const url = new URL(changed.entries[0].resolved);
        url.username = 'fixture-user';
        url.password = 'fixture-password';
        changed.entries[0].resolved = url.toString();
      }
      if (fixture.mutation === 'inventory-first-integrity')
        changed.entries[0].integrity = 'sha512-AAAA';
      if (fixture.mutation === 'inventory-lock-hash') changed.lockfileSha256 = '0'.repeat(64);
      if (fixture.mutation === 'inventory-entry-omission') changed.entries.pop();
      await assert.rejects(
        () =>
          verifyDependencies({
            profile: 'static',
            lockValue: lock,
            lockBytes,
            inventoryValue: changed,
            inventoryBytes: Buffer.from(`${JSON.stringify(changed)}\n`),
          }),
        (error) => error?.code === fixture.expectedReason,
      );
    });
});

test('license ambiguity and clean-tree acquisition cannot degrade to skipped', async () => {
  const ambiguous = clone(inventory);
  ambiguous.entries[0].license = 'UNKNOWN';
  await assert.rejects(
    () =>
      verifyDependencies({
        profile: 'static',
        lockValue: lock,
        lockBytes,
        inventoryValue: ambiguous,
        inventoryBytes: Buffer.from(`${JSON.stringify(ambiguous)}\n`),
      }),
    (error) => error?.code === 'LICENSE_AMBIGUOUS',
  );
  await assert.rejects(
    () => verifyDependencies({ profile: 'clean-tree' }),
    (error) => error?.code === 'DEPENDENCY_INSTALL_FAILED',
  );
});
