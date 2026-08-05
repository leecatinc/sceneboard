import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SCENE_RECIPE_BLOCK_KINDS_V1,
  SceneRecipeError,
  compileSceneRecipe,
  compileSceneRecipeReplaceInput,
  deriveSceneRecipeNodeId,
  parseSceneRecipeJson,
  stringifyCanonicalSceneRecipeJson,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-recipe-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(
  root,
  'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-recipe.mjs',
);
const presets = [
  'architecture-overview',
  'comparison',
  'dashboard',
  'presentation',
  'roadmap-status',
  'study-brief',
];

test('public recipe catalog and deterministic identity are stable', () => {
  assert.deepEqual(SCENE_RECIPE_BLOCK_KINDS_V1, [
    'architecture',
    'chart',
    'code',
    'dashboard',
    'drawing',
    'exact-node',
    'map',
    'markdown',
    'presentation',
    'progress',
    'status',
    'table',
  ]);
  assert.equal(
    deriveSceneRecipeNodeId({ path: ['root'], nodeKind: 'content.markdown', key: 'Résumé' }),
    deriveSceneRecipeNodeId({ path: ['root'], nodeKind: 'content.markdown', key: 'Résumé' }),
  );
  assert.match(
    deriveSceneRecipeNodeId({ path: ['root'], nodeKind: 'content.markdown', key: 'Résumé' }),
    /^n_resume_[0-9a-f]{12}$/,
  );
});

test('recipe parser rejects duplicate members and unknown fields', () => {
  assert.throws(
    () => parseSceneRecipeJson(Buffer.from('{"recipeVersion":1,"recipeVersion":1,"root":null}')),
    (error) => error instanceof SceneRecipeError && error.code === 'INVALID_JSON',
  );
  assert.throws(
    () => compileSceneRecipe({ recipeVersion: 1, root: null, extra: true }),
    (error) => error.code === 'UNKNOWN_FIELD',
  );
});

test('native recipe compilation is canonical and binding is exact', () => {
  const a = {
    recipeVersion: 1,
    root: { kind: 'markdown', key: 'summary', title: 'Summary', markdown: '# Summary' },
  };
  const b = {
    root: { markdown: '# Summary', title: 'Summary', key: 'summary', kind: 'markdown' },
    recipeVersion: 1,
  };
  assert.equal(
    stringifyCanonicalSceneRecipeJson(compileSceneRecipe(a)),
    stringifyCanonicalSceneRecipeJson(compileSceneRecipe(b)),
  );
  assert.deepEqual(
    Object.keys(
      compileSceneRecipeReplaceInput(a, {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'recipe:test:0001',
      }),
    ),
    ['boardId', 'expectedRevisionId', 'idempotencyKey', 'scene'],
  );
});

test('CLI compiles an exact scene replacement input', () => {
  const recipe = JSON.stringify({
    recipeVersion: 1,
    root: { kind: 'markdown', key: 'summary', markdown: '# Summary' },
  });
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        'compile',
        '-',
        '--output',
        'scene-replace-input',
        '--board-id',
        'board_1',
        '--expected-revision-id',
        'revision_1',
        '--idempotency-key',
        'recipe:test:cli:0001',
      ],
      { input: recipe, encoding: 'utf8' },
    ),
  );
  assert.deepEqual(Object.keys(output), [
    'boardId',
    'expectedRevisionId',
    'idempotencyKey',
    'scene',
  ]);
});

test('six native presets are discoverable and compile without artifact nodes', () => {
  const listed = JSON.parse(
    execFileSync(process.execPath, [cli, 'preset-list'], { encoding: 'utf8' }),
  );
  assert.deepEqual(listed.presets, presets);
  for (const name of presets) {
    const recipe = JSON.parse(
      readFileSync(
        join(
          root,
          'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/visual-presets',
          `${name}.json`,
        ),
        'utf8',
      ),
    );
    const first = stringifyCanonicalSceneRecipeJson(compileSceneRecipe(recipe));
    const second = execFileSync(process.execPath, [cli, 'preset-compile', name], {
      encoding: 'utf8',
    }).trim();
    assert.equal(second, first);
    assert.doesNotMatch(first, /content\.artifact/);
  }
});

test('CLI failures are fixed and do not echo unsafe input', () => {
  const canary = 'SECRET-CANARY-DO-NOT-ECHO';
  const result = spawnSync(process.execPath, [cli, 'compile'], {
    input: `{"recipeVersion":1,"root":{"kind":"${canary}"}}`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, new RegExp(canary));
  assert.equal(JSON.parse(result.stderr).error.code, 'UNKNOWN_BLOCK_KIND');
});
