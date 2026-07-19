import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { compileSceneRecipe } from '../../skills/sceanboard/scripts/scene-recipe-core.mjs';
import { compileSceneArtifactDraft, validateSceneArtifactTemplateDescriptor } from '../../skills/sceanboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const collect = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  .flatMap((entry) => entry.isDirectory() ? collect(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);

test('canonical skill, private mirror, plugin mirror, and archives are synchronized', () => {
  const result = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/sync-sceanboard-skill.mjs'), '--check'], { encoding: 'utf8' }));
  assert.deepEqual(result, { status: 'PASS', fileCount: 30 });
  const canonical = collect(join(root, 'skills/sceanboard'));
  assert.deepEqual(collect(join(root, '.AI/skills/sceanboard')), canonical);
  assert.deepEqual(collect(join(root, 'leecat-board-mcp/plugins/sceneboard/skills/sceanboard')), canonical);
  for (const name of ['sceanboard.zip', 'sceneboard-codex-plugin.zip']) {
    assert.equal(readFileSync(join(root, 'leecat-board-nextjs/public/downloads', name)).subarray(0, 4).toString('hex'), '504b0304');
  }
});

test('representative native and artifact compositions preserve their handoff boundaries', () => {
  const scene = compileSceneRecipe({ recipeVersion: 1, root: { kind: 'presentation', activePageKey: 'summary', pages: [{ key: 'summary', label: 'Summary', content: { kind: 'markdown', markdown: '# Summary\n\nThe outcome is explained here.' } }] } });
  assert.equal(scene.root.type, 'layout.tabs'); assert.equal(scene.root.tabs[0].node.type, 'content.markdown');
  const descriptor = validateSceneArtifactTemplateDescriptor(JSON.parse(readFileSync(join(root, 'skills/sceanboard/assets/artifact-templates/metric-story.json'), 'utf8')));
  const draft = compileSceneArtifactDraft({ artifactRecipeVersion: 1, template: 'metric-story', placementKey: 'summary-metric', title: 'Summary metric', fallbackText: 'Completion is seventy-five percent.', theme: 'light', size: { width: 960, height: 540 }, motion: 'subtle', content: { metrics: [{ label: 'Completion', value: '75%', detail: 'Three stages are complete.', trend: 'up' }] } }, descriptor);
  assert.equal(draft.source.artifactId, null); assert.deepEqual(draft.source.requestedCapabilities, []); assert.equal(draft.placement.nodeId.startsWith('n_summary-metric_'), true);
});

test('composer distribution contains no symlink or unsupported entry', () => {
  const inspect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false); assert.equal(entry.isFile() || entry.isDirectory(), true);
      if (entry.isDirectory()) inspect(join(directory, entry.name));
    }
  };
  inspect(join(root, 'skills/sceanboard'));
});
