import {
  chmod,
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsSecretLikeMaterial } from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(root, 'sceneboard-mcp/plugins/sceneboard');
const archivePath = resolve(root, 'sceneboard-fe/public/downloads/sceneboard.zip');
const pluginArchivePath = resolve(
  root,
  'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip',
);
const checkOnly = process.argv.includes('--check');
const releaseStateNames = new Set([
  '.sceneboard-current',
  '.sceneboard-releases',
  '.sceneboard-leases',
  '.sceneboard-publication.lock',
  '.sceneboard-activated',
  '.sceneboard-publishing',
  '.sceneboard-retired',
]);
const requiredPluginEntries = new Map([
  ['.codex-plugin/plugin.json', 'file'],
  ['.mcp.json', 'file'],
  ['scripts/launch-sceneboard-mcp.mjs', 'file'],
  ['scripts/sceneboard-mcp-config.mjs', 'file'],
  ['scripts/sceneboard-mcp-config.d.mts', 'file'],
  ['skills/sceneboard', 'directory'],
  ['skills/sceneboard/SKILL.md', 'file'],
  ['runtime/index.js', 'file'],
  ['native/profile-lease-helper', 'file'],
  ['native/profile-lease-helper.sha256', 'file'],
  ['native/linux-x64-gnu/local-export-helper', 'file'],
  ['native/linux-x64-gnu/local-export-helper.sha256', 'file'],
  ['native/local-export-helper.manifest.json', 'file'],
]);
const downloadsRoot = dirname(archivePath);
const downloadsParent = dirname(downloadsRoot);
const publicationLockPath = resolve(downloadsParent, '.sceneboard-download-publication.lock');
const publicationJournalPath = resolve(downloadsParent, '.sceneboard-download-publication.json');
const publicationBackupPath = resolve(downloadsParent, '.sceneboard-downloads-backup');
const pluginExecutableModes = new Map([
  ['scripts/launch-sceneboard-mcp.mjs', 0o755],
  ['native/profile-lease-helper', 0o500],
  ['native/linux-x64-gnu/local-export-helper', 0o500],
]);

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`skill symlinks are not allowed: ${absolute}`);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`unsupported skill entry: ${absolute}`);
  }
  return files;
};

const archiveMode = (plugin, path) => {
  const mode = plugin ? (pluginExecutableModes.get(path) ?? 0o644) : 0o644;
  if ((mode & 0o111) !== 0 && (!plugin || !pluginExecutableModes.has(path))) {
    throw new Error(`unsupported executable archive entry: ${path}`);
  }
  return 0o100000 | mode;
};

const skillEntries = async (directory, plugin = false) =>
  Promise.all(
    (await collectFiles(directory))
      .filter(
        (absolute) =>
          !plugin ||
          !['.sceneboard-activated', '.sceneboard-publishing', '.sceneboard-retired'].includes(
            relative(directory, absolute),
          ),
      )
      .map(async (absolute) => {
        const path = relative(directory, absolute).split(sep).join('/');
        return {
          path,
          bytes: await readFile(absolute),
          mode: archiveMode(plugin, path),
        };
      }),
  );

const isReleaseStatePath = (path) => {
  const topLevelName = path.split('/')[0];
  return releaseStateNames.has(topLevelName) || topLevelName.startsWith('.sceneboard-current-');
};

const collectInventoryTypes = async (directory) => {
  const inventory = new Map();
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split(sep).join('/');
      if (isReleaseStatePath(path)) continue;
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`plugin inventory contains a symlink: ${path}`);
      if (status.isDirectory()) {
        inventory.set(path, 'directory');
        await visit(absolute);
      } else if (status.isFile()) {
        inventory.set(path, 'file');
      } else {
        throw new Error(`plugin inventory contains an unsupported entry: ${path}`);
      }
    }
  };
  await visit(directory);
  return inventory;
};

const assertCompletePluginInventory = async (releaseRoot) => {
  const [canonical, release] = await Promise.all([
    collectInventoryTypes(pluginRoot),
    collectInventoryTypes(releaseRoot),
  ]);
  if (canonical.size !== release.size) throw new Error('plugin release inventory is incomplete');
  for (const [path, type] of canonical) {
    if (release.get(path) !== type) throw new Error(`plugin release inventory mismatch: ${path}`);
  }
  for (const [path, type] of requiredPluginEntries) {
    if (release.get(path) !== type) throw new Error(`required plugin entry is missing: ${path}`);
  }
};

const pluginArchiveRoot = async () => {
  await assertCompletePluginInventory(pluginRoot);
  return { root: pluginRoot, release: async () => undefined };
};

const pathStatus = (path) =>
  lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });

const isFileHeld = async (path) => {
  const target = await stat(path).catch(() => null);
  if (target === null) return false;
  const currentUid = process.geteuid?.();
  if (currentUid === undefined) return true;
  const processes = await readdir('/proc', { withFileTypes: true }).catch(() => null);
  if (processes === null) return true;
  for (const processEntry of processes) {
    if (!processEntry.isDirectory() || !/^\d+$/u.test(processEntry.name)) continue;
    const processStatus = await stat(`/proc/${processEntry.name}`).catch(() => null);
    if (processStatus === null || processStatus.uid !== currentUid) continue;
    const descriptors = await readdir(`/proc/${processEntry.name}/fd`).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      return false;
    });
    if (descriptors === false) return true;
    if (descriptors === null) continue;
    for (const descriptor of descriptors) {
      const held = await stat(`/proc/${processEntry.name}/fd/${descriptor}`).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        return false;
      });
      if (held === false) return true;
      if (held?.dev === target.dev && held.ino === target.ino) return true;
    }
  }
  return false;
};

const recoverArchivePublication = async () => {
  const [downloads, backup] = await Promise.all([
    pathStatus(downloadsRoot),
    pathStatus(publicationBackupPath),
  ]);
  let journal = null;
  try {
    journal = JSON.parse(await readFile(publicationJournalPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('download publication journal is invalid');
  }
  if (journal === null) {
    if (backup !== null) throw new Error('download publication backup is orphaned');
    return;
  }
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.stagingName !== 'string' ||
    !/^\.sceneboard-downloads-stage-[A-Za-z0-9-]+$/u.test(journal.stagingName)
  ) {
    throw new Error('download publication journal is invalid');
  }
  const stagingPath = resolve(downloadsParent, journal.stagingName);
  const staging = await pathStatus(stagingPath);
  if (downloads === null && staging !== null) {
    await rename(stagingPath, downloadsRoot);
  } else if (downloads === null && backup !== null && staging === null) {
    await rename(publicationBackupPath, downloadsRoot);
  } else if (downloads === null) {
    throw new Error('download publication cannot be recovered');
  }
  await rm(publicationBackupPath, { recursive: true, force: true });
  await rm(stagingPath, { recursive: true, force: true });
  await rm(publicationJournalPath, { force: true });
};

const withArchivePublicationLock = async (operation) => {
  const deadline = Date.now() + 10_000;
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(publicationLockPath, 'wx', 0o400);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!(await isFileHeld(publicationLockPath))) await rm(publicationLockPath, { force: true });
      else if (Date.now() >= deadline) throw new Error('download publication lock timed out');
      else await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    await recoverArchivePublication();
    return await operation();
  } finally {
    await handle.close();
    await rm(publicationLockPath, { force: true });
  }
};

const publishArchivePair = async (archive, pluginArchive) => {
  await mkdir(downloadsParent, { recursive: true });
  await withArchivePublicationLock(async () => {
    const stagingPath = await mkdtemp(resolve(downloadsParent, '.sceneboard-downloads-stage-'));
    let journalWritten = false;
    try {
      const downloadsStatus = await pathStatus(downloadsRoot);
      if (downloadsStatus !== null) {
        if (!downloadsStatus.isDirectory() || downloadsStatus.isSymbolicLink())
          throw new Error('download publication root is invalid');
        await cp(downloadsRoot, stagingPath, { recursive: true, force: false });
      }
      const stagedArchivePath = resolve(stagingPath, basename(archivePath));
      const stagedPluginArchivePath = resolve(stagingPath, basename(pluginArchivePath));
      await Promise.all([
        writeFile(stagedArchivePath, archive, { mode: 0o644 }),
        writeFile(stagedPluginArchivePath, pluginArchive, { mode: 0o644 }),
      ]);
      await Promise.all([
        chmod(stagingPath, downloadsStatus === null ? 0o755 : downloadsStatus.mode & 0o777),
        chmod(stagedArchivePath, 0o644),
        chmod(stagedPluginArchivePath, 0o644),
      ]);
      const [stagedArchive, stagedPluginArchive] = await Promise.all([
        readFile(stagedArchivePath),
        readFile(stagedPluginArchivePath),
      ]);
      const [stagedArchiveStatus, stagedPluginArchiveStatus] = await Promise.all([
        lstat(stagedArchivePath),
        lstat(stagedPluginArchivePath),
      ]);
      if (!archive.equals(stagedArchive) || !pluginArchive.equals(stagedPluginArchive))
        throw new Error('staged download archive validation failed');
      if (
        !stagedArchiveStatus.isFile() ||
        stagedArchiveStatus.isSymbolicLink() ||
        (stagedArchiveStatus.mode & 0o777) !== 0o644 ||
        !stagedPluginArchiveStatus.isFile() ||
        stagedPluginArchiveStatus.isSymbolicLink() ||
        (stagedPluginArchiveStatus.mode & 0o777) !== 0o644
      ) {
        throw new Error('staged download archive type or mode is invalid');
      }
      if (process.env.SCENEBOARD_ARCHIVE_PUBLISH_TEST_FAULT === 'before-publication')
        throw new Error('download publication interrupted');
      await writeFile(
        publicationJournalPath,
        `${JSON.stringify({ schemaVersion: 1, stagingName: basename(stagingPath) })}\n`,
        { flag: 'wx', mode: 0o400 },
      );
      journalWritten = true;
      await rm(publicationBackupPath, { recursive: true, force: true });
      if ((await pathStatus(downloadsRoot)) !== null)
        await rename(downloadsRoot, publicationBackupPath);
      if (process.env.SCENEBOARD_ARCHIVE_PUBLISH_TEST_FAULT === 'after-retire')
        throw new Error('download publication interrupted');
      await rename(stagingPath, downloadsRoot);
      await rm(publicationBackupPath, { recursive: true, force: true });
      await rm(publicationJournalPath, { force: true });
      journalWritten = false;
      const [publishedArchive, publishedPluginArchive] = await Promise.all([
        readFile(archivePath),
        readFile(pluginArchivePath),
      ]);
      if (!archive.equals(publishedArchive) || !pluginArchive.equals(publishedPluginArchive))
        throw new Error('published download archive validation failed');
    } catch (error) {
      if (journalWritten) await recoverArchivePublication();
      else await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  });
};

const assertSafeFiles = (entries, requiredPath) => {
  if (requiredPath !== undefined && !entries.some(({ path }) => path === requiredPath))
    throw new Error(`${requiredPath} is missing`);
  for (const { path, bytes } of entries) {
    const text = bytes.toString('utf8');
    if (containsSecretLikeMaterial(text)) {
      throw new Error(`secret-like material found in ${path}`);
    }
  }
};

const zipArchive = (entries, prefix) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(`${prefix}/${entry.path}`, 'utf8');
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const activePlugin = await pluginArchiveRoot();
try {
  const canonicalRoot = resolve(activePlugin.root, 'skills/sceneboard');
  const canonical = await skillEntries(canonicalRoot);
  assertSafeFiles(canonical, 'SKILL.md');
  const plugin = await skillEntries(activePlugin.root, true);
  assertSafeFiles(plugin, '.codex-plugin/plugin.json');
  const archive = zipArchive(canonical, 'sceneboard');
  const pluginArchive = zipArchive(plugin, 'sceneboard');

  if (checkOnly) {
    const [publishedArchive, publishedPluginArchive] = await Promise.all([
      readFile(archivePath),
      readFile(pluginArchivePath),
    ]);
    if (!archive.equals(publishedArchive)) throw new Error('download archive is stale');
    if (!pluginArchive.equals(publishedPluginArchive))
      throw new Error('plugin download archive is stale');
    console.log(JSON.stringify({ status: 'PASS', fileCount: canonical.length }));
  } else {
    await publishArchivePair(archive, pluginArchive);
    console.log(
      JSON.stringify({
        status: 'SYNCED',
        fileCount: canonical.length,
        archives: [
          'sceneboard-fe/public/downloads/sceneboard.zip',
          'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip',
        ],
      }),
    );
  }
} finally {
  await activePlugin.release();
}
