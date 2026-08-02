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
const exportHelperTarget = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper');
const exportDigestTarget = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper.sha256');
const exportManifestTarget = resolve(pluginRoot, 'native/local-export-helper.manifest.json');
const exportSource = resolve(root, 'sceneboard-mcp/native/local-export-helper.c');
const checkOnly = process.argv.includes('--check');
const runtimeOnly = process.argv.includes('--runtime-only');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'sceneboard-plugin-release-'));
const runtimeCandidate = resolve(temporaryRoot, 'index.js');
const helperCandidate = resolve(temporaryRoot, 'profile-lease-helper');
const exportHelperCandidate = resolve(temporaryRoot, 'local-export-helper');

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

const compileExportHelper = async () => {
  const child = spawn(
    'cc',
    [
      '-std=c17',
      '-D_FORTIFY_SOURCE=2',
      '-O2',
      '-fPIE',
      '-pie',
      '-Wl,--build-id=none',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      exportHelperCandidate,
      exportSource,
    ],
    { stdio: 'inherit', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) throw new Error('SceneBoard plugin local export helper compilation failed');
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
  const buildSteps = [
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
  ];
  if (!runtimeOnly) buildSteps.push(compileHelper(), compileExportHelper());
  await Promise.all(buildSteps);

  let nativeArtifacts = null;
  if (!runtimeOnly) {
    const helperBytes = await readFile(helperCandidate);
    const digest = `${createHash('sha256').update(helperBytes).digest('hex')}\n`;
    const exportHelperBytes = await readFile(exportHelperCandidate);
    const exportDigestValue = createHash('sha256').update(exportHelperBytes).digest('hex');
    nativeArtifacts = {
      digest,
      exportDigest: `${exportDigestValue}\n`,
      exportManifest: `${JSON.stringify(
        {
          version: 1,
          targets: {
            'linux-x64-gnu': {
              path: 'linux-x64-gnu/local-export-helper',
              sha256: exportDigestValue,
              mode: '0500',
            },
          },
        },
        null,
        2,
      )}\n`,
    };
  }

  if (checkOnly) {
    const checks = [assertEqualFile(runtimeCandidate, runtimeTarget, 'plugin runtime')];
    if (nativeArtifacts !== null) {
      checks.push(
        assertEqualFile(helperCandidate, helperTarget, 'plugin native helper'),
        assertEqualFile(exportHelperCandidate, exportHelperTarget, 'plugin local export helper'),
      );
    }
    await Promise.all(checks);
    if (
      nativeArtifacts !== null &&
      (await readFile(digestTarget, 'utf8')) !== nativeArtifacts.digest
    )
      throw new Error('plugin native helper digest is stale');
    if (
      nativeArtifacts !== null &&
      (await readFile(exportDigestTarget, 'utf8')) !== nativeArtifacts.exportDigest
    )
      throw new Error('plugin local export helper digest is stale');
    if (
      nativeArtifacts !== null &&
      (await readFile(exportManifestTarget, 'utf8')) !== nativeArtifacts.exportManifest
    )
      throw new Error('plugin local export helper manifest is stale');
    console.log(JSON.stringify({ status: 'PASS', runtime: 'runtime/index.js' }));
  } else {
    const directories = [dirname(runtimeTarget)];
    if (nativeArtifacts !== null) {
      directories.push(dirname(helperTarget), dirname(exportHelperTarget));
    }
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));

    const writableTargets = [runtimeTarget];
    if (nativeArtifacts !== null) {
      writableTargets.push(
        helperTarget,
        digestTarget,
        exportHelperTarget,
        exportDigestTarget,
        exportManifestTarget,
      );
    }
    await Promise.all(writableTargets.map(makeWritable));

    const publications = [copyFile(runtimeCandidate, runtimeTarget)];
    if (nativeArtifacts !== null) {
      publications.push(
        copyFile(helperCandidate, helperTarget),
        writeFile(digestTarget, nativeArtifacts.digest, { mode: 0o400 }),
        copyFile(exportHelperCandidate, exportHelperTarget),
        writeFile(exportDigestTarget, nativeArtifacts.exportDigest, { mode: 0o400 }),
        writeFile(exportManifestTarget, nativeArtifacts.exportManifest, { mode: 0o400 }),
      );
    }
    await Promise.all(publications);

    const finalModes = [chmod(runtimeTarget, 0o644)];
    if (nativeArtifacts !== null) {
      finalModes.push(
        setExactMode(helperTarget, 0o500),
        setExactMode(digestTarget, 0o400),
        setExactMode(exportHelperTarget, 0o500),
        setExactMode(exportDigestTarget, 0o400),
        setExactMode(exportManifestTarget, 0o400),
      );
    }
    await Promise.all(finalModes);
    console.log(JSON.stringify({ status: 'BUILT', runtime: 'runtime/index.js' }));
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
