import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const workspaceRoot = resolve(repositoryRoot, '..');
const sourceRoot = resolve(workspaceRoot, 'skills/sceneboard');
const pluginRoot = resolve(repositoryRoot, 'sceneboard-mcp/plugins/sceneboard/skills/sceneboard');
const privateMirrorRoot = resolve(
  workspaceRoot,
  '../lc-skills/marketplace/private/lc-skills/skills/sceneboard',
);
const stateRoot = resolve(repositoryRoot, '.sceneboard-skill-sync');

const stateSnapshot = () => {
  if (!existsSync(stateRoot)) return null;
  const visit = (directory) =>
    readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .flatMap((entry) => {
        const absolute = join(directory, entry.name);
        const path = relative(stateRoot, absolute).replaceAll('\\', '/');
        return entry.isDirectory()
          ? visit(absolute)
          : [[path, readFileSync(absolute).toString('hex')]];
      });
  return visit(stateRoot);
};

const inventory = (root) => {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const absolute = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) visit(absolute);
      else {
        assert.equal(entry.isFile(), true);
        files.set(relative(root, absolute).replaceAll('\\', '/'), {
          bytes: readFileSync(absolute),
          mode: lstatSync(absolute).mode & 0o777,
        });
      }
    }
  };
  visit(root);
  return files;
};

test('root SceneBoard skill is the exact authority for plugin and private deployment mirror', () => {
  const stateBefore = stateSnapshot();
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(repositoryRoot, 'scripts/sync-sceneboard-skill-source.mjs'), '--check'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(stateSnapshot(), stateBefore, '--check must not mutate publication state');
  const source = inventory(sourceRoot);
  assert.equal(result.status, 'PASS');
  assert.equal(result.fileCount, source.size);
  for (const projectionRoot of [pluginRoot, privateMirrorRoot]) {
    const projection = inventory(projectionRoot);
    assert.deepEqual([...projection.keys()], [...source.keys()]);
    for (const [path, file] of source) {
      assert.equal(file.mode, 0o644, `${path} authority mode`);
      assert.deepEqual(projection.get(path), file, path);
    }
  }
});

test('portable validators pass from authored and private deployment mirror trees', () => {
  for (const root of [sourceRoot, privateMirrorRoot]) {
    const output = execFileSync('python3', [join(root, 'scripts/quick_validate.py')], {
      encoding: 'utf8',
    });
    assert.match(output, /validation PASS/u);
  }
});
