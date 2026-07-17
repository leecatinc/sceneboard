import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { MIGRATION_REGISTRY } from '../src/database/migrations/registry.js';

const sourceDirectory = new URL('../src/database/migrations/sql/', import.meta.url);
const outputDirectory = new URL('../dist/database/migrations/sql/', import.meta.url);

const expectedAssets = new Set<string>();
for (const entry of MIGRATION_REGISTRY) {
  expectedAssets.add(entry.upAsset);
  if (entry.downAsset !== null) expectedAssets.add(entry.downAsset);
}

const listSqlFiles = async (directory: URL): Promise<string[]> => {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

const assertExactSet = (label: string, actual: readonly string[]): void => {
  const expected = [...expectedAssets].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} SQL assets differ from the migration registry`);
  }
};

const main = async (): Promise<void> => {
  const sourceAssets = await listSqlFiles(sourceDirectory);
  assertExactSet('source', sourceAssets);
  await mkdir(outputDirectory, { recursive: true });
  const existingOutputAssets = await listSqlFiles(outputDirectory);
  const unexpectedOutput = existingOutputAssets.filter((asset) => !expectedAssets.has(asset));
  if (unexpectedOutput.length > 0) throw new Error(`compiled SQL directory contains stale assets: ${unexpectedOutput.join(', ')}`);

  for (const asset of sourceAssets) {
    const source = await readFile(new URL(asset, sourceDirectory));
    new TextDecoder('utf-8', { fatal: true }).decode(source);
    await writeFile(new URL(asset, outputDirectory), source, { flag: 'w' });
    const copied = await readFile(new URL(asset, outputDirectory));
    if (!source.equals(copied)) throw new Error(`compiled SQL asset differs from source: ${asset}`);
  }
  assertExactSet('compiled', await listSqlFiles(outputDirectory));
};

await main();
