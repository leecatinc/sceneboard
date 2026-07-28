import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson } from '../../scripts/lib/certification/canonical-json.mjs';
import {
  validatePresentationInventory,
  verifyPresentationContractManifest,
} from '../../scripts/verify-presentation-contract-manifest.mjs';

const inventoryUrl = new URL(
  '../certification/presentation-contract-input-inventory.v1.json',
  import.meta.url,
);
const manifestUrl = new URL(
  '../certification/presentation-contract-manifest.v1.json',
  import.meta.url,
);
const releaseUrl = new URL('../certification/presentation-release-index.v1.json', import.meta.url);
const fixturesUrl = new URL(
  '../certification/fixtures/presentation-contract-manifest/',
  import.meta.url,
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);

test('presentation manifest closes exact requirements, decisions, owners, and release exclusion', async () => {
  const manifestBytes = await readFile(manifestUrl);
  const releaseIndexBytes = await readFile(releaseUrl);
  assert.equal(manifestBytes.toString('utf8'), `${canonicalJson(JSON.parse(manifestBytes))}\n`);
  assert.equal(
    releaseIndexBytes.toString('utf8'),
    `${canonicalJson(JSON.parse(releaseIndexBytes))}\n`,
  );
  const result = await verifyPresentationContractManifest();
  assert.deepEqual(
    {
      status: result.status,
      requirementCount: result.requirementCount,
      decisionCount: result.decisionCount,
      ownerCount: result.ownerCount,
      evidenceCount: result.evidenceCount,
      reducedAssurance: result.reducedAssurance,
    },
    {
      status: 'PASS',
      requirementCount: 16,
      decisionCount: 6,
      ownerCount: 28,
      evidenceCount: 11,
      reducedAssurance: true,
    },
  );
});

test('presentation inventory mutation fixtures fail closed at their owning invariant', async (context) => {
  const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
  const names = [
    'missing-requirement.v1.json',
    'owner-swap.v1.json',
    'orphan-publisher.v1.json',
    'self-reference.v1.json',
    'exclusion-as-pass.v1.json',
    'duplicate-publisher-path.v1.json',
  ];
  for (const name of names) {
    await context.test(name, async () => {
      const fixture = JSON.parse(await readFile(new URL(name, fixturesUrl), 'utf8'));
      const changed = clone(inventory);
      if (fixture.mutation === 'missing-requirement') changed.requirements.splice(3, 1);
      else if (fixture.mutation === 'owner-swap') changed.owners[0].boundaryOwner = 'D2';
      else if (fixture.mutation === 'orphan-publisher')
        changed.publishers.push({
          publisherId: 'PUB-ORPHAN',
          kind: 'schema',
          ownerIssue: 'I-44',
          boundaryOwner: 'D9',
          path: 'package.json',
        });
      else if (fixture.mutation === 'self-reference')
        changed.publishers[0].path = 'test/certification/presentation-contract-manifest.v1.json';
      else if (fixture.mutation === 'exclusion-as-pass')
        changed.evidence[0].evidenceId = 'database-capacity';
      else if (fixture.mutation === 'duplicate-publisher-path')
        changed.publishers.at(-1).path = changed.publishers[0].path;
      await assert.rejects(
        () =>
          validatePresentationInventory({
            inventoryValue: changed,
            inventoryBytes: bytes(changed),
          }),
        (error) => error?.code === fixture.expectedCode,
      );
    });
  }
});

test('release index cannot omit the content hash of the current-run AMD-06 exclusion', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('exclusion-hash-omission.v1.json', fixturesUrl), 'utf8'),
  );
  const release = JSON.parse(await readFile(releaseUrl, 'utf8'));
  delete release.exclusion.recordSha256;
  await assert.rejects(
    () =>
      verifyPresentationContractManifest({
        releaseIndexValue: release,
        releaseIndexBytes: bytes(release),
      }),
    (error) => error?.code === fixture.expectedCode,
  );
});
