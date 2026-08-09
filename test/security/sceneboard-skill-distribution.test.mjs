import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { collectFiles } from '../../scripts/sync-sceneboard-skill-source.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const source = readFileSync(
  resolve(repositoryRoot, 'scripts/sync-sceneboard-skill-source.mjs'),
  'utf8',
);

test('skill publisher closes symlink, secret and escaped-authority paths', () => {
  assert.match(source, /isSymbolicLink\(\)/u);
  assert.match(source, /containsSecretLikeMaterial/u);
  assert.match(source, /workspaceRoot, 'skills\/sceneboard'/u);
  assert.match(
    source,
    /workspaceRoot,\s*'\.\.\/lc-skills\/marketplace\/private\/lc-skills\/skills\/sceneboard'/u,
  );
  assert.doesNotMatch(source, /\.AI\/skills\/sceneboard/u);
  assert.match(source, /chmod\(absolute, skillFileMode\)/u);
  assert.match(source, /const skillFileMode = 0o644/u);
  assert.doesNotMatch(source, /\b(?:fchmod|chown|setfacl)\b/u);
  assert.doesNotMatch(source, /mode:\s*0o(?:400|600|700)/u);
  assert.doesNotMatch(source, /process\.env\.(?:HOME|CODEX_HOME)/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:bytes|text)/u);
});

test('skill publisher rejects a symlinked authority root before traversal', async (context) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'sceneboard-skill-root-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  symlinkSync(resolve(temporary, 'missing-target'), resolve(temporary, 'authority'));
  await assert.rejects(
    collectFiles(resolve(temporary, 'authority')),
    /authority root must be a real directory/u,
  );
});

test('plugin archive source excludes volatile publication state', () => {
  const archivePublisher = readFileSync(
    resolve(repositoryRoot, 'scripts/sync-sceneboard-skill.mjs'),
    'utf8',
  );
  assert.match(archivePublisher, /isReleaseStatePath/u);
  for (const name of [
    '.sceneboard-current',
    '.sceneboard-releases',
    '.sceneboard-leases',
    '.sceneboard-publication.lock',
  ]) {
    assert.match(archivePublisher, new RegExp(name.replaceAll('.', '\\.')));
  }
});
