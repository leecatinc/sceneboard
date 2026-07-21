import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileSceneRecipe } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-recipe-core.mjs';

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/visual-presets',
);
const expected = [
  'architecture-overview.json',
  'comparison.json',
  'dashboard.json',
  'presentation.json',
  'roadmap-status.json',
  'study-brief.json',
];

test('native preset catalog is exact, valid, and content neutral', () => {
  assert.deepEqual(readdirSync(root).sort(), expected);
  for (const filename of expected) {
    const raw = readFileSync(join(root, filename), 'utf8');
    assert.doesNotMatch(raw, /https?:|@|token|api.?key|content\.artifact/i);
    const scene = compileSceneRecipe(JSON.parse(raw));
    assert.equal(scene.protocolVersion, 1);
    assert.ok(scene.root);
  }
});
