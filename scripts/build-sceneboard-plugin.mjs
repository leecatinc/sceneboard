import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(root, 'sceneboard-mcp/plugins/sceneboard');
const runtimeTarget = resolve(pluginRoot, 'runtime/index.js');
const helperTarget = resolve(pluginRoot, 'native/profile-lease-helper');
const digestTarget = resolve(pluginRoot, 'native/profile-lease-helper.sha256');
const source = resolve(root, 'sceneboard-mcp/native/profile-lease-helper.c');
const checkOnly = process.argv.includes('--check');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'sceneboard-plugin-release-'));
const runtimeCandidate = resolve(temporaryRoot, 'index.js');
const helperCandidate = resolve(temporaryRoot, 'profile-lease-helper');

const compileHelper = async () => {
  const child = spawn(
    'cc',
    [
      '-std=c17',
      '-D_FORTIFY_SOURCE=2',
      '-O2',
      '-fPIE',
      '-pie',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      helperCandidate,
      source,
    ],
    { stdio: 'inherit', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) throw new Error('SceneBoard plugin native helper compilation failed');
};

const setExactMode = async (path, mode) => {
  const clearAcl = spawn('/usr/bin/setfacl', ['-b', path], { stdio: 'ignore' });
  await new Promise((resolveExit) => {
    clearAcl.once('error', () => resolveExit(null));
    clearAcl.once('exit', resolveExit);
  });
  await chmod(path, mode);
};

const assertEqualFile = async (expected, actual, label) => {
  const [expectedBytes, actualBytes] = await Promise.all([readFile(expected), readFile(actual)]);
  if (!expectedBytes.equals(actualBytes)) throw new Error(`${label} is stale`);
};

const makeWritable = async (path) => {
  await chmod(path, 0o600).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
};

try {
  await Promise.all([
    build({
      entryPoints: [resolve(root, 'sceneboard-mcp/src/index.ts')],
      outfile: runtimeCandidate,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      legalComments: 'none',
      logLevel: 'silent',
    }),
    compileHelper(),
  ]);
  const helperBytes = await readFile(helperCandidate);
  const digest = `${createHash('sha256').update(helperBytes).digest('hex')}\n`;

  if (checkOnly) {
    await Promise.all([
      assertEqualFile(runtimeCandidate, runtimeTarget, 'plugin runtime'),
      assertEqualFile(helperCandidate, helperTarget, 'plugin native helper'),
    ]);
    if ((await readFile(digestTarget, 'utf8')) !== digest)
      throw new Error('plugin native helper digest is stale');
    console.log(JSON.stringify({ status: 'PASS', runtime: 'runtime/index.js' }));
  } else {
    await Promise.all([
      mkdir(dirname(runtimeTarget), { recursive: true }),
      mkdir(dirname(helperTarget), { recursive: true }),
    ]);
    await Promise.all([
      makeWritable(runtimeTarget),
      makeWritable(helperTarget),
      makeWritable(digestTarget),
    ]);
    await Promise.all([
      copyFile(runtimeCandidate, runtimeTarget),
      copyFile(helperCandidate, helperTarget),
      writeFile(digestTarget, digest, { mode: 0o400 }),
    ]);
    await Promise.all([
      chmod(runtimeTarget, 0o644),
      setExactMode(helperTarget, 0o500),
      setExactMode(digestTarget, 0o400),
    ]);
    console.log(JSON.stringify({ status: 'BUILT', runtime: 'runtime/index.js' }));
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
