import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsSecretLikeMaterial } from './lib/certification/canonical-json.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(repositoryRoot, '..');
const sourceRoot = resolve(workspaceRoot, 'skills/sceneboard');
const pluginRoot = resolve(repositoryRoot, 'sceneboard-mcp/plugins/sceneboard/skills/sceneboard');
const privateMirrorRoot = resolve(
  workspaceRoot,
  '../lc-skills/marketplace/private/lc-skills/skills/sceneboard',
);
const stateRoot = resolve(repositoryRoot, '.sceneboard-skill-sync');
const temporaryRoot = resolve('/workspace/.tmp/agent');
const lockPath = resolve(stateRoot, 'publication.lock');
const journalPath = resolve(stateRoot, 'publication.json');
const checkOnly = process.argv.includes('--check');
const adoptPlugin = process.argv.includes('--adopt-plugin');
const skillFileMode = 0o644;

const pathStatus = (path) =>
  lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });

const assertAuthorityRoot = async (root) => {
  const status = await lstat(root);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error('SceneBoard skill authority root must be a real directory');
  if ((await realpath(root)) !== root)
    throw new Error('SceneBoard skill authority root must not traverse a symlink');
};

export const collectFiles = async (root) => {
  await assertAuthorityRoot(root);
  const files = new Map();
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      const status = await lstat(absolute);
      if (status.isSymbolicLink())
        throw new Error(`SceneBoard skill symlink is not allowed: ${path}`);
      if (status.isDirectory()) await visit(absolute);
      else if (status.isFile()) {
        const bytes = await readFile(absolute);
        if (containsSecretLikeMaterial(bytes.toString('utf8')))
          throw new Error(`secret-like material found in SceneBoard skill file: ${path}`);
        files.set(path, Object.freeze({ bytes, mode: status.mode & 0o777 }));
      } else throw new Error(`unsupported SceneBoard skill entry: ${path}`);
    }
  };
  await visit(root);
  return files;
};

const digestInventory = (files) => {
  const hash = createHash('sha256');
  for (const [path, file] of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(file.mode));
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const assertEqualInventory = async (expected, targetRoot, label) => {
  const actual = await collectFiles(targetRoot);
  if (actual.size !== expected.size) throw new Error(`${label} inventory is stale`);
  for (const [path, file] of expected) {
    const target = actual.get(path);
    if (
      file.mode !== skillFileMode ||
      target === undefined ||
      target.mode !== file.mode ||
      !target.bytes.equals(file.bytes)
    )
      throw new Error(`${label} is stale: ${path}`);
  }
};

const normalizeFileModes = async (root) => {
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) await chmod(absolute, skillFileMode);
      else throw new Error(`unsupported SceneBoard skill entry: ${absolute}`);
    }
  };
  await visit(root);
};

const replaceTree = async (targetRoot, source, digest) => {
  const parent = dirname(targetRoot);
  await mkdir(parent, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  const stagingContainer = await mkdtemp(resolve(temporaryRoot, '.sceneboard-stage-'));
  const stagingRoot = resolve(stagingContainer, 'sceneboard');
  try {
    await cp(source, stagingRoot, { recursive: true, force: false, errorOnExist: true });
    await normalizeFileModes(stagingRoot);
    await assertEqualInventory(await collectFiles(source), stagingRoot, 'staged SceneBoard skill');
    const backupRoot = `${targetRoot}.backup-${digest}`;
    await rm(backupRoot, { recursive: true, force: true });
    if ((await pathStatus(targetRoot)) !== null) await rename(targetRoot, backupRoot);
    try {
      await rename(stagingRoot, targetRoot);
      await rm(backupRoot, { recursive: true, force: true });
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true });
      if ((await pathStatus(backupRoot)) !== null) await rename(backupRoot, targetRoot);
      throw error;
    }
  } finally {
    await rm(stagingContainer, { recursive: true, force: true });
  }
};

const withLock = async (operation) => {
  await mkdir(stateRoot, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ownerText = await readFile(lockPath, 'utf8').catch(() => '');
      const ownerPid = /^(?:[1-9][0-9]*)\n$/u.test(ownerText) ? Number(ownerText.trim()) : null;
      if (ownerPid === null) throw new Error('SceneBoard skill publication lock is invalid');
      let ownerAlive = true;
      try {
        process.kill(ownerPid, 0);
      } catch (ownerError) {
        ownerAlive = ownerError?.code === 'EPERM';
      }
      if (ownerAlive) throw new Error('SceneBoard skill publication is already running');
      await rm(lockPath, { force: true });
    }
  }
  if (handle === undefined) throw new Error('SceneBoard skill publication lock was not acquired');
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
};

const readJournal = async () => {
  const status = await pathStatus(journalPath);
  if (status === null) return null;
  if (status.isSymbolicLink() || !status.isFile())
    throw new Error('SceneBoard skill publication journal is invalid');
  const value = JSON.parse(await readFile(journalPath, 'utf8'));
  if (
    value?.schemaVersion !== 1 ||
    typeof value.digest !== 'string' ||
    !['plugin', 'mirror', 'verify'].includes(value.phase)
  )
    throw new Error('SceneBoard skill publication journal is invalid');
  return value;
};

const writeJournal = async (digest, phase) => {
  const temporary = `${journalPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, digest, phase })}\n`, {
    flag: 'wx',
  });
  await rename(temporary, journalPath);
};

const publishProjections = async (source, digest) => {
  await writeJournal(digest, 'plugin');
  await replaceTree(pluginRoot, sourceRoot, digest);
  await writeJournal(digest, 'mirror');
  await replaceTree(privateMirrorRoot, sourceRoot, digest);
  await writeJournal(digest, 'verify');
  await assertEqualInventory(source, pluginRoot, 'plugin SceneBoard skill');
  await assertEqualInventory(source, privateMirrorRoot, 'private deployment mirror');
  await rm(journalPath, { force: true });
};

const main = async () => {
  if (checkOnly) {
    if ((await pathStatus(journalPath)) !== null)
      throw new Error('SceneBoard skill publication recovery is pending');
    const source = await collectFiles(sourceRoot);
    const digest = digestInventory(source);
    await assertEqualInventory(source, pluginRoot, 'plugin SceneBoard skill');
    await assertEqualInventory(source, privateMirrorRoot, 'private deployment mirror');
    console.log(JSON.stringify({ status: 'PASS', digest, fileCount: source.size }));
    return;
  }

  if (adoptPlugin) {
    await withLock(async () => {
      const plugin = await collectFiles(pluginRoot);
      const source = await collectFiles(sourceRoot);
      const mergedRoot = await mkdtemp(resolve(dirname(sourceRoot), '.sceneboard-adopt-'));
      await cp(pluginRoot, mergedRoot, { recursive: true, force: false, errorOnExist: true });
      for (const [path] of source) {
        if (plugin.has(path)) continue;
        const from = resolve(sourceRoot, path);
        const to = resolve(mergedRoot, path);
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { force: false, errorOnExist: true });
      }
      const merged = await collectFiles(mergedRoot);
      const digest = digestInventory(merged);
      await replaceTree(sourceRoot, mergedRoot, digest);
      await rm(mergedRoot, { recursive: true, force: true });
      console.log(JSON.stringify({ status: 'ADOPTED', digest, fileCount: merged.size }));
    });
    return;
  }

  await withLock(async () => {
    const interrupted = await readJournal();
    const source = await collectFiles(sourceRoot);
    const digest = digestInventory(source);
    await publishProjections(source, digest);
    console.log(
      JSON.stringify({
        status: interrupted === null ? 'SYNCED' : 'RECOVERED',
        digest,
        fileCount: source.size,
      }),
    );
  });
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
