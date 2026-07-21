import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsSecretLikeMaterial } from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(root, 'sceneboard-mcp/plugins/sceneboard');
const pluginSkillRoot = resolve(pluginRoot, 'skills/sceneboard');
const canonicalRoot = pluginSkillRoot;
const archivePath = resolve(root, 'sceneboard-fe/public/downloads/sceneboard.zip');
const pluginArchivePath = resolve(
  root,
  'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip',
);
const checkOnly = process.argv.includes('--check');

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

const skillEntries = async (directory) =>
  Promise.all(
    (await collectFiles(directory)).map(async (absolute) => {
      const status = await lstat(absolute);
      return {
        path: relative(directory, absolute).split(sep).join('/'),
        bytes: await readFile(absolute),
        mode: 0o100000 | (status.mode & 0o777),
      };
    }),
  );

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

const canonical = await skillEntries(canonicalRoot);
assertSafeFiles(canonical, 'SKILL.md');
const archive = zipArchive(canonical, 'sceneboard');

if (checkOnly) {
  if (!archive.equals(await readFile(archivePath))) throw new Error('download archive is stale');
  const plugin = await skillEntries(pluginRoot);
  assertSafeFiles(plugin, '.codex-plugin/plugin.json');
  if (!zipArchive(plugin, 'sceneboard').equals(await readFile(pluginArchivePath)))
    throw new Error('plugin download archive is stale');
  console.log(JSON.stringify({ status: 'PASS', fileCount: canonical.length }));
} else {
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive, { mode: 0o644 });
  const plugin = await skillEntries(pluginRoot);
  assertSafeFiles(plugin, '.codex-plugin/plugin.json');
  await writeFile(pluginArchivePath, zipArchive(plugin, 'sceneboard'), { mode: 0o644 });
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
