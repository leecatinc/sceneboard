import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalJson,
  containsSecretLikeMaterial,
} from '../../scripts/lib/certification/canonical-json.mjs';
import {
  observeContractInventory,
  validateManifestShape,
  verifyContractManifest,
} from '../../scripts/verify-contract-manifest.mjs';

const fixtureRoot = new URL('../certification/fixtures/contract-manifest/', import.meta.url);
const inventoryUrl = new URL('../certification/contract-input-inventory.v1.json', import.meta.url);
const readFixture = async (name) => {
  const bytes = await readFile(new URL(name, fixtureRoot));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const mutationBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const rejectsCode = async (operation, code) =>
  assert.rejects(operation, (error) => error?.code === code);

test('installed-skill secret scanner covers contextual fragments and arbitrary private store roots', () => {
  for (const value of [
    `{"proof":"${'p'.repeat(43)}"}`,
    `generation: ${'g'.repeat(22)}`,
    `{"proof":{"value":"${'p'.repeat(43)}"}}`,
    `{"generation":[{"value":"${'g'.repeat(22)}"}]}`,
    '/opt/private/leecat-board/credentials/profile/credential.json',
    'C:\\private\\leecat-board\\credentials\\profile\\credential.json',
  ])
    assert.equal(containsSecretLikeMaterial(value), true);
  for (const value of [
    'proof: short-placeholder',
    '{"proof":{"value":"ordinary answer"}}',
    '{"generation":[{"value":"short-placeholder"}]}',
    'generation field is documented',
    '/opt/public/sceneboard/readme',
  ]) {
    assert.equal(containsSecretLikeMaterial(value), false);
  }
});

test('golden manifest is canonical, stable, and exactly reproducible from all 473 closed inputs', async () => {
  const golden = await readFixture('golden.v1.json');
  assert.equal(golden.bytes.toString('utf8'), `${canonicalJson(golden.value)}\n`);
  const result = await verifyContractManifest({
    manifestValue: golden.value,
    manifestBytes: golden.bytes,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.ownerCount, 9);
  assert.equal(result.resourceCount, 473);
  assert.equal(result.migrationCount, 31);
  assert.equal(result.sqlAssetCount, 34);
  assert.equal(result.finalToolCount, 30);
});

test('manifest hash-placement fixtures fail closed', async (context) => {
  const fixtures = [
    ['missing-inventory-hash.v1.json', 'CONTRACT_MANIFEST_SCHEMA_INVALID'],
    ['misplaced-runtime-field.v1.json', 'CONTRACT_RUNTIME_FIELD_MISPLACED'],
    ['self-reference.v1.json', 'CONTRACT_MANIFEST_SELF_REFERENCE'],
  ];
  for (const [name, code] of fixtures) {
    await context.test(name, async () => {
      const fixture = await readFixture(name);
      await rejectsCode(
        () =>
          verifyContractManifest({ manifestValue: fixture.value, manifestBytes: fixture.bytes }),
        code,
      );
    });
  }
});

test('manifest rejects unknown top-level fields before observing source', () => {
  assert.throws(
    () =>
      validateManifestShape({
        schemaVersion: 1,
        inventorySha256: '0'.repeat(64),
        inferredBaseline: true,
      }),
    (error) => error?.code === 'CONTRACT_MANIFEST_SCHEMA_INVALID',
  );
});

test('inventory rejects aliases, owner swaps, whole-file overlap, and publisher omission', async (context) => {
  const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
  await context.test('second resource alias', async () => {
    const changed = clone(inventory);
    const group = changed.entries.find(({ id }) => id === 'D4-SEAMS');
    const duplicate = clone(group.resources[0]);
    duplicate.resourceId = group.resources.at(-1).resourceId;
    group.resources[group.resources.length - 1] = duplicate;
    await rejectsCode(
      () =>
        observeContractInventory({
          inventoryValue: changed,
          inventoryBytes: mutationBytes(changed),
        }),
      'CONTRACT_GLOBAL_KEY_DUPLICATE',
    );
  });
  await context.test('D8 browser owner swap', async () => {
    const changed = clone(inventory);
    const group = changed.entries.find(({ id }) => id === 'D5-BROWSER-API-SEAMS');
    group.resources.find(
      ({ resourceId }) => resourceId === 'D8-HITL-MUTATION-REQUEST-SELECTOR',
    ).owner = 'D7';
    await rejectsCode(
      () =>
        observeContractInventory({
          inventoryValue: changed,
          inventoryBytes: mutationBytes(changed),
        }),
      'CONTRACT_OWNER_PUBLISHER_STALE',
    );
  });
  await context.test('whole-file and member projection overlap', async () => {
    const changed = clone(inventory);
    const group = changed.entries.find(({ id }) => id === 'D3-BOARD-SEAMS');
    const target = group.resources.find(
      ({ resourceId }) => resourceId === 'D3-OUTBOX-LOAD-PENDING',
    );
    target.exportName = null;
    target.exportKind = null;
    target.projectionId = null;
    target.selector = 'whole-file';
    await rejectsCode(
      () =>
        observeContractInventory({
          inventoryValue: changed,
          inventoryBytes: mutationBytes(changed),
        }),
      'CONTRACT_WHOLE_FILE_PROJECTION_OVERLAP',
    );
  });
  await context.test('explicit D8 publisher source omission', async () => {
    const changed = clone(inventory);
    const group = changed.entries.find(({ id }) => id === 'D5-BROWSER-API-SEAMS');
    const targetIndex = group.resources.findIndex(
      ({ resourceId }) => resourceId === 'D8-HITL-LIFECYCLE-SUPERSEDE-SELECTOR',
    );
    group.resources[targetIndex] = {
      resourceId: 'D8-HITL-LIFECYCLE-SUPERSEDE-SELECTOR',
      owner: 'D8',
      path: 'sceneboard-fe/test/contracts/certification-publisher.test-helper.ts',
      exportName: null,
      exportKind: null,
      projectionId: null,
      selector: 'whole-file',
    };
    await rejectsCode(
      () =>
        observeContractInventory({
          inventoryValue: changed,
          inventoryBytes: mutationBytes(changed),
        }),
      'CONTRACT_OWNER_PUBLISHER_STALE',
    );
  });
  await context.test('installed skill inventory omits one canonical file', async () => {
    const changed = clone(inventory);
    const group = changed.entries.find(({ id }) => id === 'D6-INSTALLED-SKILL');
    group.resources.at(-1).path = 'package.json';
    await rejectsCode(
      () =>
        observeContractInventory({
          inventoryValue: changed,
          inventoryBytes: mutationBytes(changed),
        }),
      'CONTRACT_INPUT_DRIFT',
    );
  });
});

test('all committed contract-inventory mutation fixtures are consumed with exact reasons', async (context) => {
  const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
  const golden = await readFixture('golden.v1.json');
  const fixtureRoot = new URL('../certification/fixtures/contract-inventory/', import.meta.url);
  const names = [
    'duplicate-alias.v1.json',
    'owner-swap.v1.json',
    'whole-file-projection-overlap.v1.json',
    'overlapping-projections.v1.json',
    'missing-owner-publisher.v1.json',
    'publisher-source-omission.v1.json',
    'browser-adapter-owner-swap.v1.json',
    'browser-adapter-selector-overlap.v1.json',
    'browser-adapter-d8-publisher-omission.v1.json',
    'browser-adapter-d8-member-signature-drift.v1.json',
  ];
  for (const name of names)
    await context.test(name, async () => {
      const fixture = JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'));
      const changed = clone(inventory);
      const d4 = changed.entries.find(({ id }) => id === 'D4-SEAMS');
      const d3 = changed.entries.find(({ id }) => id === 'D3-BOARD-SEAMS');
      const publishers = changed.entries.find(({ id }) => id === 'D2-D5-D7-D8-BROWSER-PUBLISHERS');
      const browser = changed.entries.find(({ id }) => id === 'D5-BROWSER-API-SEAMS');
      if (fixture.mutation === 'duplicate-d4-resource') {
        const duplicate = clone(d4.resources[0]);
        duplicate.resourceId = d4.resources.at(-1).resourceId;
        d4.resources[d4.resources.length - 1] = duplicate;
      }
      if (fixture.mutation === 'swap-d4-owner') d4.resources[0].owner = 'D3';
      if (fixture.mutation === 'whole-file-d3-outbox') {
        Object.assign(
          d3.resources.find(({ resourceId }) => resourceId === 'D3-OUTBOX-LOAD-PENDING'),
          {
            exportName: null,
            exportKind: null,
            projectionId: null,
            selector: 'whole-file',
          },
        );
      }
      if (fixture.mutation === 'duplicate-d3-selector') {
        const source = d3.resources.find(
          ({ resourceId }) => resourceId === 'D3-OUTBOX-LIST-PENDING',
        );
        const target = d3.resources.find(
          ({ resourceId }) => resourceId === 'D3-OUTBOX-LOAD-PENDING',
        );
        target.exportName = source.exportName;
        target.exportKind = source.exportKind;
        target.selector = source.selector;
      }
      if (
        fixture.mutation === 'omit-d2-publisher-input' ||
        fixture.mutation === 'omit-d8-publisher-input'
      ) {
        const owner = fixture.mutation === 'omit-d2-publisher-input' ? 'D2' : 'D8';
        const target = publishers.resources.find(
          ({ resourceId }) => resourceId === `${owner}-BROWSER-PUBLISHER`,
        );
        target.path = 'sceneboard-fe/test/contracts/certification-publisher.test-helper.ts';
      }
      if (fixture.mutation === 'omit-d8-source-selector') {
        const target = browser.resources.find(
          ({ resourceId }) => resourceId === 'D8-HITL-LIFECYCLE-SUPERSEDE-SELECTOR',
        );
        Object.assign(target, {
          path: 'sceneboard-fe/test/contracts/certification-publisher.test-helper.ts',
          exportName: null,
          exportKind: null,
          projectionId: null,
          selector: 'whole-file',
        });
      }
      if (fixture.mutation === 'swap-d8-selector-owner') {
        browser.resources.find(
          ({ resourceId }) => resourceId === 'D8-HITL-MUTATION-REQUEST-SELECTOR',
        ).owner = 'D7';
      }
      if (fixture.mutation === 'duplicate-d8-selector') {
        const source = browser.resources.find(
          ({ resourceId }) => resourceId === 'D8-HITL-LIFECYCLE-CANCEL-SELECTOR',
        );
        const target = browser.resources.find(
          ({ resourceId }) => resourceId === 'D8-HITL-LIFECYCLE-SUPERSEDE-SELECTOR',
        );
        target.exportName = source.exportName;
        target.exportKind = source.exportKind;
        target.selector = source.selector;
      }
      if (fixture.mutation === 'replace-d8-selector-with-private-method') {
        const target = browser.resources.find(
          ({ resourceId }) => resourceId === 'D8-HITL-MUTATION-REQUEST-SELECTOR',
        );
        target.selector =
          'ClassDeclaration[name=BoardApiClient]/MethodDeclaration[name=connectionApi]';
      }
      await rejectsCode(
        () =>
          verifyContractManifest({
            manifestValue: golden.value,
            manifestBytes: golden.bytes,
            inventoryValue: changed,
            inventoryBytes: mutationBytes(changed),
          }),
        fixture.expectedReason,
      );
    });
});
