import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registry = JSON.parse(
  await readFile(new URL('../../sceneboard-fe/qa/registry.json', import.meta.url), 'utf8'),
);
const cases = registry.scenarios.flatMap((scenario) => scenario.cases);
const workspaceRoot = new URL('../../../', import.meta.url);

test('generated HP-QA cases do not claim executable coverage before exact harness verification', () => {
  assert.equal(registry.schema, 'hpipe.profile.qa-registry');
  assert.equal(registry.version, 3);
  assert.equal(cases.length, 134);
  assert.match(registry.source_digest, /^[0-9a-f]{64}$/u);
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  for (const project of registry.projects) {
    for (const automationPath of project.automation_paths) {
      assert.doesNotMatch(
        automationPath,
        /run-hpqa-library-case|sceneboard-hpqa-case/u,
        project.id,
      );
      assert.equal(existsSync(new URL(automationPath, workspaceRoot)), true, automationPath);
    }
  }
  for (const entry of cases) {
    assert.equal(entry.verification_state, 'generated_unverified', entry.id);
    assert.equal(entry.automation_status, 'generated_unverified', entry.id);
    assert.equal(entry.last_verified_digest, null, entry.id);
    assert.deepEqual(entry.adapters, [], entry.id);
  }
});

test('landing graph cases describe the shipped static preview contract', () => {
  const details = cases.find(({ id }) => id === 'SCB-LANDING-GRAPH-STATIC-001');
  const responsive = cases.find(({ id }) => id === 'SCB-LANDING-GRAPH-RESPONSIVE-001');
  assert.ok(details);
  assert.ok(responsive);
  assert.match(details.assertions.join(' '), /no dialog, inspector, or activation semantics/u);
  assert.match(details.assertions.join(' '), /matching identifier/u);
  assert.match(responsive.assertions.join(' '), /static graph remains presentational/u);
});
