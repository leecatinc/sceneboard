import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
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

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;

const sameMetadata = (left, right) =>
  left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;

export const updateProjection = async (targetRoot, source, label) => {
  const target = await collectFiles(targetRoot);
  if (target.size !== source.size || [...source.keys()].some((path) => !target.has(path)))
    throw new Error(`${label} inventory change requires explicit reconciliation`);

  const updates = [];
  for (const [path, file] of source) {
    const current = target.get(path);
    if (file.mode !== skillFileMode || current.mode !== file.mode)
      throw new Error(`${label} metadata drift requires explicit reconciliation: ${path}`);
    if (current.bytes.equals(file.bytes)) continue;
    const absolute = resolve(targetRoot, path);
    const before = await lstat(absolute);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
      throw new Error(`${label} target is unsafe: ${path}`);
    updates.push({ absolute, before, bytes: file.bytes, path });
  }

  for (const update of updates) {
    let handle;
    try {
      handle = await open(update.absolute, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!sameIdentity(update.before, opened) || !sameMetadata(update.before, opened))
        throw new Error(`${label} target changed before publication: ${update.path}`);
      await handle.truncate(0);
      await handle.writeFile(update.bytes);
      await handle.sync();
      const published = await handle.stat();
      if (!sameIdentity(update.before, published) || !sameMetadata(update.before, published))
        throw new Error(`${label} target metadata changed during publication: ${update.path}`);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  await assertEqualInventory(source, targetRoot, label);
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
  await updateProjection(pluginRoot, source, 'plugin SceneBoard skill');
  await writeJournal(digest, 'mirror');
  await updateProjection(privateMirrorRoot, source, 'private deployment mirror');
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
    throw new Error('--adopt-plugin requires explicit ownership reconciliation');
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
