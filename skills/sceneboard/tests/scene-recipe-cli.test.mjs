import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(skillRoot, 'scripts', 'scene-recipe.mjs');
const recipe = JSON.stringify({ recipeVersion: 1, root: null });
const bindingArgs = [
  '--board-id',
  'board_test',
  '--expected-revision-id',
  'revision_test',
  '--idempotency-key',
  'scene-recipe-test-v1',
];

const run = (args, options = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });

const assertReplaceInput = (output) => {
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'boardId',
    'expectedRevisionId',
    'idempotencyKey',
    'scene',
  ]);
  assert.equal(parsed.boardId, 'board_test');
  assert.equal(parsed.expectedRevisionId, 'revision_test');
  assert.equal(parsed.idempotencyKey, 'scene-recipe-test-v1');
  assert.deepEqual(parsed.scene, {
    protocolVersion: 1,
    root: null,
    type: 'scene',
  });
};

test('compile emits an exact deterministic scene replace input', () => {
  const args = ['compile', '-', '--output', 'scene-replace-input', ...bindingArgs];
  const first = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input: recipe,
  });
  const second = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input: recipe,
  });

  assert.equal(second, first);
  assert.equal(
    first,
    '{"boardId":"board_test","expectedRevisionId":"revision_test","idempotencyKey":"scene-recipe-test-v1","scene":{"protocolVersion":1,"root":null,"type":"scene"}}\n',
  );
  assertReplaceInput(first);
});

test('preset-compile emits an exact deterministic scene replace input', () => {
  const args = [
    'preset-compile',
    'presentation',
    '--output',
    'scene-replace-input',
    ...bindingArgs,
  ];
  const first = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
  const second = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });

  assert.equal(second, first);
  const parsed = JSON.parse(first);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'boardId',
    'expectedRevisionId',
    'idempotencyKey',
    'scene',
  ]);
  assert.equal(parsed.boardId, 'board_test');
  assert.equal(parsed.expectedRevisionId, 'revision_test');
  assert.equal(parsed.idempotencyKey, 'scene-recipe-test-v1');
  assert.equal(parsed.scene.protocolVersion, 1);
  assert.equal(parsed.scene.type, 'scene');
});

test('scene output stays unchanged and binding flags remain all-or-nothing', () => {
  const scene = execFileSync(process.execPath, [cli, 'compile', '-', '--output', 'scene'], {
    encoding: 'utf8',
    input: recipe,
  });
  assert.equal(scene, '{"protocolVersion":1,"root":null,"type":"scene"}\n');
  assert.deepEqual(JSON.parse(scene), {
    protocolVersion: 1,
    root: null,
    type: 'scene',
  });

  for (const args of [
    ['compile', '-', '--output', 'scene-replace-input'],
    ['compile', '-', '--output', 'scene-replace-input', ...bindingArgs.slice(0, 2)],
    ['compile', '-', '--output', 'scene-replace-input', ...bindingArgs.slice(0, 4)],
    ['preset-compile', 'presentation', '--output', 'scene-replace-input'],
    [
      'preset-compile',
      'presentation',
      '--output',
      'scene-replace-input',
      ...bindingArgs.slice(0, 2),
    ],
    [
      'preset-compile',
      'presentation',
      '--output',
      'scene-replace-input',
      ...bindingArgs.slice(0, 4),
    ],
  ]) {
    const result = run(args, args[0] === 'compile' ? { input: recipe } : {});
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'CLI_USAGE');
  }
});
