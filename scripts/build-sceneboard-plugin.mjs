import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
const releaseStore = resolve(pluginRoot, '.sceneboard-releases');
const releasePointer = resolve(pluginRoot, '.sceneboard-current');
const publicationLock = resolve(pluginRoot, '.sceneboard-publication.lock');
const leaseStore = resolve(pluginRoot, '.sceneboard-leases');
const retiredMarker = '.sceneboard-retired';
const publishingMarker = '.sceneboard-publishing';
const activatedMarker = '.sceneboard-activated';
const releaseNamePattern = /^generation-[A-Za-z0-9-]+$/u;
const releaseCleanupGraceMs =
  process.env.SCENEBOARD_PLUGIN_PUBLISH_TEST_CLEANUP === 'immediate' ? 0 : 30_000;
const publicationLockTimeoutMs = 10_000;
const releaseStateNames = new Set([
  basename(releaseStore),
  basename(leaseStore),
  basename(releasePointer),
  basename(publicationLock),
  retiredMarker,
  publishingMarker,
  activatedMarker,
]);
const generatedPluginPaths = new Set([
  'runtime/index.js',
  'native/profile-lease-helper',
  'native/profile-lease-helper.sha256',
  'native/linux-x64-gnu/local-export-helper',
  'native/linux-x64-gnu/local-export-helper.sha256',
  'native/local-export-helper.manifest.json',
]);
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

const isReleaseStatePath = (path) => {
  const topLevelName = path.split('/')[0];
  return releaseStateNames.has(topLevelName) || topLevelName.startsWith('.sceneboard-current-');
};

const collectPluginInventory = async (inventoryRoot, { omitGenerated = false } = {}) => {
  const inventory = new Map();
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const absolute = join(directory, entry.name);
      const path = relative(inventoryRoot, absolute).split(sep).join('/');
      if (isReleaseStatePath(path) || (omitGenerated && generatedPluginPaths.has(path))) continue;
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`plugin inventory contains a symlink: ${path}`);
      if (status.isDirectory()) {
        inventory.set(path, { type: 'directory' });
        await visit(absolute);
      } else if (status.isFile()) {
        inventory.set(path, { type: 'file', bytes: await readFile(absolute) });
      } else {
        throw new Error(`plugin inventory contains an unsupported entry: ${path}`);
      }
    }
  };
  await visit(inventoryRoot);
  return inventory;
};

const assertCanonicalInventory = async (releaseRoot) => {
  const [canonical, release] = await Promise.all([
    collectPluginInventory(pluginRoot, { omitGenerated: true }),
    collectPluginInventory(releaseRoot, { omitGenerated: true }),
  ]);
  if (canonical.size !== release.size) throw new Error('plugin canonical inventory is stale');
  for (const [path, expected] of canonical) {
    const actual = release.get(path);
    if (actual?.type !== expected.type)
      throw new Error(`plugin canonical inventory is stale: ${path}`);
    if (expected.type === 'file' && !expected.bytes.equals(actual.bytes)) {
      throw new Error(`plugin canonical file is stale: ${path}`);
    }
  }
};

const readActiveReleaseName = async () => {
  const pointerStatus = await lstat(releasePointer).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (pointerStatus !== null && (!pointerStatus.isFile() || pointerStatus.isSymbolicLink())) {
    throw new Error('SceneBoard plugin release pointer is invalid');
  }
  const value = await readFile(releasePointer, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (value === null) return null;
  const name = value.trim();
  if (!releaseNamePattern.test(name) || value !== `${name}\n`)
    throw new Error('SceneBoard plugin release pointer is invalid');
  const status = await lstat(resolve(releaseStore, name));
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error('SceneBoard plugin release is invalid');
  return name;
};

const isLeaseHeld = async (leasePath) => {
  const lease = await stat(leasePath).catch(() => null);
  if (lease === null) return false;
  const currentUid = process.geteuid?.();
  if (currentUid === undefined) return true;
  const processes = await readdir('/proc', { withFileTypes: true }).catch(() => null);
  if (processes === null) return true;
  for (const processEntry of processes) {
    if (!processEntry.isDirectory() || !/^\d+$/u.test(processEntry.name)) continue;
    const processStatus = await stat(`/proc/${processEntry.name}`).catch(() => null);
    if (processStatus === null || processStatus.uid !== currentUid) continue;
    const descriptorRoot = `/proc/${processEntry.name}/fd`;
    const descriptors = await readdir(descriptorRoot).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      return false;
    });
    if (descriptors === false) return true;
    if (descriptors === null) continue;
    for (const descriptor of descriptors) {
      const held = await stat(resolve(descriptorRoot, descriptor)).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        return false;
      });
      if (held === false) return true;
      if (held?.dev === lease.dev && held.ino === lease.ino) return true;
    }
  }
  return false;
};

const hasHeldLease = async (releaseName) => {
  const entries = await readdir(leaseStore, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  let held = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${releaseName}.`)) continue;
    const leasePath = resolve(leaseStore, entry.name);
    if (await isLeaseHeld(leasePath)) held = true;
    else await rm(leasePath, { force: true });
  }
  return held;
};

const hasHeldAcquisition = async () => {
  const entries = await readdir(leaseStore, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  let held = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('acquire.')) continue;
    const leasePath = resolve(leaseStore, entry.name);
    if (await isLeaseHeld(leasePath)) held = true;
    else await rm(leasePath, { force: true });
  }
  return held;
};

const withPublicationLock = async (operation) => {
  const deadline = Date.now() + publicationLockTimeoutMs;
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(publicationLock, 'wx', 0o400);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!(await isLeaseHeld(publicationLock))) await rm(publicationLock, { force: true });
      else if (Date.now() >= deadline)
        throw new Error('SceneBoard plugin publication lock timed out');
      else await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(publicationLock, { force: true });
  }
};

const markAndCollectRetiredReleases = async () => {
  await withPublicationLock(async () => {
    if (await hasHeldAcquisition()) return;
    const entries = await readdir(releaseStore, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !releaseNamePattern.test(entry.name)) continue;
      if ((await readActiveReleaseName()) === entry.name) continue;
      const releasePath = resolve(releaseStore, entry.name);
      const publishingPath = resolve(releasePath, publishingMarker);
      const publishing = await stat(publishingPath).catch(() => null);
      if (publishing !== null && (await isLeaseHeld(publishingPath))) continue;
      const activated = await stat(resolve(releasePath, activatedMarker)).catch(() => null);
      if (activated === null) {
        if (publishing === null || now - publishing.mtimeMs < releaseCleanupGraceMs) continue;
        if ((await readActiveReleaseName()) === entry.name) continue;
        await rm(releasePath, { recursive: true, force: true });
        continue;
      }
      if ((await readActiveReleaseName()) === entry.name) continue;
      const markerPath = resolve(releasePath, retiredMarker);
      await writeFile(markerPath, '', { flag: 'wx', mode: 0o400 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      const marker = await stat(markerPath);
      if (
        now - marker.mtimeMs < releaseCleanupGraceMs ||
        (await hasHeldLease(entry.name)) ||
        (await readActiveReleaseName()) === entry.name
      )
        continue;
      const currentPublishing = await stat(publishingPath).catch(() => null);
      if (currentPublishing !== null && (await isLeaseHeld(publishingPath))) continue;
      await rm(releasePath, { recursive: true, force: true });
    }
  });
};

const assertCompleteRelease = async (releasePath) => {
  const required = [
    '.mcp.json',
    'scripts',
    'skills',
    'runtime/index.js',
    'native/profile-lease-helper',
    'native/profile-lease-helper.sha256',
    'native/linux-x64-gnu/local-export-helper',
    'native/linux-x64-gnu/local-export-helper.sha256',
    'native/local-export-helper.manifest.json',
  ];
  for (const name of required) {
    const status = await lstat(resolve(releasePath, name));
    if (status.isSymbolicLink()) throw new Error(`staged plugin inventory is invalid: ${name}`);
    if ((name === 'scripts' || name === 'skills') && !status.isDirectory())
      throw new Error(`staged plugin inventory is invalid: ${name}`);
    if (name !== 'scripts' && name !== 'skills' && !status.isFile())
      throw new Error(`staged plugin inventory is invalid: ${name}`);
  }
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
    const activeReleaseName = await readActiveReleaseName();
    const checkRoot =
      activeReleaseName === null ? pluginRoot : resolve(releaseStore, activeReleaseName);
    const checkPath = (path) => resolve(checkRoot, path.slice(pluginRoot.length + 1));
    await assertCanonicalInventory(checkRoot);
    const checks = [assertEqualFile(runtimeCandidate, checkPath(runtimeTarget), 'plugin runtime')];
    if (nativeArtifacts !== null) {
      checks.push(
        assertEqualFile(helperCandidate, checkPath(helperTarget), 'plugin native helper'),
        assertEqualFile(
          exportHelperCandidate,
          checkPath(exportHelperTarget),
          'plugin local export helper',
        ),
      );
    }
    await Promise.all(checks);
    if (
      nativeArtifacts !== null &&
      (await readFile(checkPath(digestTarget), 'utf8')) !== nativeArtifacts.digest
    )
      throw new Error('plugin native helper digest is stale');
    if (
      nativeArtifacts !== null &&
      (await readFile(checkPath(exportDigestTarget), 'utf8')) !== nativeArtifacts.exportDigest
    )
      throw new Error('plugin local export helper digest is stale');
    if (
      nativeArtifacts !== null &&
      (await readFile(checkPath(exportManifestTarget), 'utf8')) !== nativeArtifacts.exportManifest
    )
      throw new Error('plugin local export helper manifest is stale');
    console.log(JSON.stringify({ status: 'PASS', runtime: 'runtime/index.js' }));
  } else {
    const pluginStatus = await lstat(pluginRoot);
    if (!pluginStatus.isDirectory() || pluginStatus.isSymbolicLink())
      throw new Error('SceneBoard plugin root is invalid');
    await Promise.all([
      mkdir(releaseStore, { recursive: true, mode: 0o700 }),
      mkdir(leaseStore, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([chmod(releaseStore, 0o700), chmod(leaseStore, 0o700)]);
    const releaseRoot = await mkdtemp(resolve(dirname(pluginRoot), '.sceneboard-release-'));
    const releaseCandidate = resolve(releaseRoot, 'candidate');
    const generationName = `generation-${basename(releaseRoot).slice('.sceneboard-release-'.length)}`;
    const sealedRelease = resolve(releaseStore, generationName);
    await cp(pluginRoot, releaseCandidate, {
      recursive: true,
      force: false,
      filter: (sourcePath) => {
        if (sourcePath === pluginRoot) return true;
        const path = relative(pluginRoot, sourcePath).split(sep).join('/');
        return !isReleaseStatePath(path);
      },
    });
    const candidatePath = (path) => resolve(releaseCandidate, path.slice(pluginRoot.length + 1));
    const candidateRuntime = candidatePath(runtimeTarget);
    const writableTargets = [candidateRuntime];
    if (nativeArtifacts !== null) {
      writableTargets.push(
        candidatePath(helperTarget),
        candidatePath(digestTarget),
        candidatePath(exportHelperTarget),
        candidatePath(exportDigestTarget),
        candidatePath(exportManifestTarget),
      );
    }
    await Promise.all(writableTargets.map(makeWritable));

    const publications = [copyFile(runtimeCandidate, candidateRuntime)];
    if (nativeArtifacts !== null) {
      publications.push(
        copyFile(helperCandidate, candidatePath(helperTarget)),
        writeFile(candidatePath(digestTarget), nativeArtifacts.digest, { mode: 0o400 }),
        copyFile(exportHelperCandidate, candidatePath(exportHelperTarget)),
        writeFile(candidatePath(exportDigestTarget), nativeArtifacts.exportDigest, { mode: 0o400 }),
        writeFile(candidatePath(exportManifestTarget), nativeArtifacts.exportManifest, {
          mode: 0o400,
        }),
      );
    }
    await Promise.all(publications);

    const finalModes = [chmod(candidateRuntime, 0o644)];
    if (nativeArtifacts !== null) {
      finalModes.push(
        setExactMode(candidatePath(helperTarget), 0o500),
        setExactMode(candidatePath(digestTarget), 0o400),
        setExactMode(candidatePath(exportHelperTarget), 0o500),
        setExactMode(candidatePath(exportDigestTarget), 0o400),
        setExactMode(candidatePath(exportManifestTarget), 0o400),
      );
    }
    finalModes.push(
      chmod(releaseCandidate, 0o755),
      chmod(resolve(releaseCandidate, 'runtime'), 0o755),
      chmod(resolve(releaseCandidate, 'native'), 0o755),
      chmod(resolve(releaseCandidate, 'native/linux-x64-gnu'), 0o755),
    );
    await Promise.all(finalModes);
    await assertEqualFile(runtimeCandidate, candidateRuntime, 'staged plugin runtime');
    if (nativeArtifacts !== null) {
      await Promise.all([
        assertEqualFile(helperCandidate, candidatePath(helperTarget), 'staged native helper'),
        assertEqualFile(
          exportHelperCandidate,
          candidatePath(exportHelperTarget),
          'staged local export helper',
        ),
      ]);
    }
    await assertCanonicalInventory(releaseCandidate);
    await assertCompleteRelease(releaseCandidate);
    const publishingHandle = await open(resolve(releaseCandidate, publishingMarker), 'wx', 0o400);
    await rename(releaseCandidate, sealedRelease);
    const pointerCandidate = resolve(pluginRoot, `.sceneboard-current-${generationName}`);
    try {
      await writeFile(pointerCandidate, `${generationName}\n`, { flag: 'wx', mode: 0o400 });
      if (
        process.env.SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT === 'pause-after-retire' &&
        typeof process.send === 'function'
      ) {
        process.send({ event: 'sceneboard_plugin_after_retire' });
        await new Promise((resolveResume, rejectResume) => {
          const timeout = setTimeout(
            () => rejectResume(new Error('SceneBoard plugin publication interrupted')),
            2_000,
          );
          process.once('message', (message) => {
            clearTimeout(timeout);
            if (message === 'resume') resolveResume();
            else rejectResume(new Error('SceneBoard plugin publication interrupted'));
          });
        });
      }
      if (process.env.SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT === 'after-retire')
        throw new Error('SceneBoard plugin publication interrupted');
      await withPublicationLock(async () => {
        await writeFile(resolve(sealedRelease, activatedMarker), '', { flag: 'wx', mode: 0o400 });
        const canonicalRuntimeCandidate = resolve(pluginRoot, `.runtime-${generationName}.tmp`);
        try {
          await copyFile(runtimeCandidate, canonicalRuntimeCandidate);
          await chmod(canonicalRuntimeCandidate, 0o644);
          await rename(canonicalRuntimeCandidate, runtimeTarget);
        } finally {
          await rm(canonicalRuntimeCandidate, { force: true });
        }
        await rename(pointerCandidate, releasePointer);
        await publishingHandle.close();
        await rm(resolve(sealedRelease, publishingMarker), { force: true });
      });
      if (
        process.env.SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT === 'pause-after-activate' &&
        typeof process.send === 'function'
      ) {
        process.send({ event: 'sceneboard_plugin_after_activate' });
        await new Promise((resolveResume, rejectResume) => {
          const timeout = setTimeout(
            () => rejectResume(new Error('SceneBoard plugin publication interrupted')),
            2_000,
          );
          process.once('message', (message) => {
            clearTimeout(timeout);
            if (message === 'resume') resolveResume();
            else rejectResume(new Error('SceneBoard plugin publication interrupted'));
          });
        });
      }
      await markAndCollectRetiredReleases();
    } catch (error) {
      await publishingHandle.close().catch(() => undefined);
      await rm(pointerCandidate, { force: true });
      await withPublicationLock(async () => {
        if ((await readActiveReleaseName().catch(() => null)) !== generationName)
          await rm(sealedRelease, { recursive: true, force: true });
      });
      throw error;
    }
    await rm(releaseRoot, { recursive: true, force: true });
    console.log(JSON.stringify({ status: 'BUILT', runtime: 'runtime/index.js' }));
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
