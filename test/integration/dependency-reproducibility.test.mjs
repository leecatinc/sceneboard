import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  observeDependencyInventory,
  verifyDependencies,
} from '../../scripts/verify-dependency-reproducibility.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lockBytes = await readFile(new URL('../../package-lock.json', import.meta.url));
const lock = JSON.parse(lockBytes.toString('utf8'));
const inventory = JSON.parse(
  await readFile(new URL('../certification/dependency-inventory.v1.json', import.meta.url), 'utf8'),
);
const fixtureRoot = new URL(
  '../certification/fixtures/dependency-reproducibility/',
  import.meta.url,
);

test('committed public-registry dependency inventory matches the hydrated static tree', async () => {
  assert.deepEqual(observeDependencyInventory(), inventory);
  const result = await verifyDependencies({ profile: 'static' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.registryHost, 'registry.npmjs.org');
  assert.equal(result.dependencyCount, 588);
  assert.equal(result.npmVersion, '10.9.3');
  assert.ok(result.nodeMajor >= 22);
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
