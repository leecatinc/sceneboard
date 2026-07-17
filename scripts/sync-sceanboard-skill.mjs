import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsSecretLikeMaterial } from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = resolve(root, 'skills/sceanboard');
const mirrorRoot = resolve(root, '.AI/skills/sceanboard');
const pluginRoot = resolve(root, 'leecat-board-mcp/plugins/sceneboard');
const pluginSkillRoot = resolve(pluginRoot, 'skills/sceanboard');
const archivePath = resolve(root, 'leecat-board-nextjs/public/downloads/sceanboard.zip');
const pluginArchivePath = resolve(root, 'leecat-board-nextjs/public/downloads/sceneboard-codex-plugin.zip');
const checkOnly = process.argv.includes('--check');

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
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
    if (entry.isDirectory()) files.push(...await collectFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`unsupported skill entry: ${absolute}`);
  }
  return files;
};

const skillEntries = async (directory) => Promise.all((await collectFiles(directory)).map(async (absolute) => ({
  path: relative(directory, absolute).split(sep).join('/'),
  bytes: await readFile(absolute),
})));

const assertSafeFiles = (entries, requiredPath) => {
  if (requiredPath !== undefined && !entries.some(({ path }) => path === requiredPath)) throw new Error(`${requiredPath} is missing`);
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
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
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

const assertEqualTrees = async (expected, actualRoot) => {
  const actual = await skillEntries(actualRoot);
  if (expected.length !== actual.length) throw new Error('skill mirror file count differs');
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].path !== actual[index].path || !expected[index].bytes.equals(actual[index].bytes)) {
      throw new Error(`skill mirror differs at ${expected[index].path}`);
    }
  }
};

const canonical = await skillEntries(canonicalRoot);
assertSafeFiles(canonical, 'SKILL.md');
const archive = zipArchive(canonical, 'sceanboard');

if (checkOnly) {
  await assertEqualTrees(canonical, mirrorRoot);
  await assertEqualTrees(canonical, pluginSkillRoot);
  if (!archive.equals(await readFile(archivePath))) throw new Error('download archive is stale');
  const plugin = await skillEntries(pluginRoot);
  assertSafeFiles(plugin, '.codex-plugin/plugin.json');
  if (!zipArchive(plugin, 'sceneboard').equals(await readFile(pluginArchivePath))) throw new Error('plugin download archive is stale');
  console.log(JSON.stringify({ status: 'PASS', fileCount: canonical.length }));
} else {
  await rm(mirrorRoot, { recursive: true, force: true });
  await rm(pluginSkillRoot, { recursive: true, force: true });
  await mkdir(dirname(mirrorRoot), { recursive: true });
  await mkdir(dirname(pluginSkillRoot), { recursive: true });
  await cp(canonicalRoot, mirrorRoot, { recursive: true, errorOnExist: true });
  await cp(canonicalRoot, pluginSkillRoot, { recursive: true, errorOnExist: true });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive, { mode: 0o644 });
  await assertEqualTrees(canonical, mirrorRoot);
  await assertEqualTrees(canonical, pluginSkillRoot);
  const plugin = await skillEntries(pluginRoot);
  assertSafeFiles(plugin, '.codex-plugin/plugin.json');
  await writeFile(pluginArchivePath, zipArchive(plugin, 'sceneboard'), { mode: 0o644 });
  console.log(JSON.stringify({
    status: 'SYNCED',
    fileCount: canonical.length,
    archives: [
      'leecat-board-nextjs/public/downloads/sceanboard.zip',
      'leecat-board-nextjs/public/downloads/sceneboard-codex-plugin.zip',
    ],
  }));
}
