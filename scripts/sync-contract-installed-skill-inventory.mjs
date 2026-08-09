#!/usr/bin/env node
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(root, 'test/certification/contract-input-inventory.v1.json');
const installedRoot = resolve(root, 'sceneboard-mcp/plugins/sceneboard/skills/sceneboard');
const migrationRegistryPath = resolve(root, 'sceneboard-be/src/database/migrations/registry.ts');
const migrationSqlRoot = resolve(root, 'sceneboard-be/src/database/migrations/sql');

const collect = async (directory = installedRoot) => {
  const paths = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new TypeError('installed skill symlink is not allowed');
    if (entry.isDirectory()) paths.push(...(await collect(absolute)));
    else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join('/'));
    else throw new TypeError('installed skill entry type is invalid');
  }
  return paths;
};

const inputStatus = await lstat(inventoryPath);
if (!inputStatus.isFile() || inputStatus.isSymbolicLink())
  throw new TypeError('contract inventory is unsafe');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const installedEntry = inventory.entries?.find(({ id }) => id === 'D6-INSTALLED-SKILL');
const migrationEntry = inventory.entries?.find(({ id }) => id === 'MIGRATION-REGISTRY-ASSETS');
if (
  installedEntry === undefined ||
  !Array.isArray(installedEntry.resources) ||
  migrationEntry === undefined ||
  !Array.isArray(migrationEntry.resources)
)
  throw new TypeError('generated contract inventory entry is missing');

const rebuildEntry = (entry, paths, prefix, owner) => {
  const retainedIds = new Map(entry.resources.map(({ path, resourceId }) => [path, resourceId]));
  let nextId = entry.resources.reduce((maximum, { resourceId }) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`, 'u').exec(resourceId);
    return Math.max(maximum, match === null ? 0 : Number(match[1]));
  }, 0);
  entry.resources = paths.map((path) => ({
    resourceId: retainedIds.get(path) ?? `${prefix}-${String(++nextId).padStart(2, '0')}`,
    owner,
    path,
    exportName: null,
    exportKind: null,
    projectionId: null,
    selector: 'whole-file',
  }));
  entry.expectedCardinality = entry.resources.length;
};

rebuildEntry(installedEntry, await collect(), 'D6-SKILL', 'D6');
rebuildEntry(
  migrationEntry,
  [
    relative(root, migrationRegistryPath).split(sep).join('/'),
    ...(await collect(migrationSqlRoot)),
  ],
  'MIGRATION-ASSET',
  'D3',
);

const temporary = resolve(dirname(inventoryPath), `.${process.pid}.contract-inventory.tmp`);
let handle;
try {
  handle = await open(temporary, 'wx', 0o600);
  await handle.writeFile(`${canonicalJson(inventory)}\n`, 'utf8');
  await handle.sync();
  await handle.close();
  handle = undefined;
  await rename(temporary, inventoryPath);
} finally {
  if (handle !== undefined) await handle.close();
  await rm(temporary, { force: true });
}

process.stdout.write(
  `${JSON.stringify({
    status: 'UPDATED',
    entries: [
      { id: installedEntry.id, fileCount: installedEntry.resources.length },
      { id: migrationEntry.id, fileCount: migrationEntry.resources.length },
    ],
  })}\n`,
);
