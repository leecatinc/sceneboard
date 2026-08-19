import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { collectFiles, updateProjection } from '../../scripts/sync-sceneboard-skill-source.mjs';

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
  assert.match(source, /const skillFileMode = 0o644/u);
  assert.match(source, /constants\.O_NOFOLLOW/u);
  assert.match(source, /inventory change requires explicit reconciliation/u);
  assert.match(source, /sameIdentity/u);
  assert.match(source, /sameMetadata/u);
  assert.doesNotMatch(source, /\b(?:chmod|fchmod|chown|setfacl)\b/u);
  assert.doesNotMatch(source, /rename\(stagingRoot|replaceTree/u);
  assert.doesNotMatch(source, /mode:\s*0o(?:400|600|700)/u);
  assert.doesNotMatch(source, /process\.env\.(?:HOME|CODEX_HOME)/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:bytes|text)/u);
});

test('skill publisher updates existing bytes without replacing metadata', async (context) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'sceneboard-skill-publish-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const authority = resolve(temporary, 'authority');
  const projection = resolve(temporary, 'projection');
  await mkdir(authority);
  await mkdir(projection);
  const authorityFile = resolve(authority, 'SKILL.md');
  const projectionFile = resolve(projection, 'SKILL.md');
  await writeFile(authorityFile, 'new bytes\n');
  await writeFile(projectionFile, 'old bytes\n');
  await chmod(authorityFile, 0o644);
  await chmod(projectionFile, 0o644);
  const before = await stat(projectionFile);

  await updateProjection(projection, await collectFiles(authority), 'test projection');

  const after = await stat(projectionFile);
  assert.equal(await readFile(projectionFile, 'utf8'), 'new bytes\n');
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode, before.mode);
  assert.equal(after.nlink, before.nlink);
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
