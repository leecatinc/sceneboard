import { readdir, readFile } from 'node:fs/promises';

export const loadFixture = async (path: string): Promise<unknown> => {
  const url = new URL(`../fixtures/${path}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
};

export const loadFixtureBytes = async (path: string): Promise<Uint8Array> => {
  const url = new URL(`../fixtures/${path}`, import.meta.url);
  return new Uint8Array(await readFile(url));
};

const collectFixturePaths = async (directory: URL, prefix = ''): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) paths.push(...await collectFixturePaths(new URL(`${entry.name}/`, directory), `${path}/`));
    else if (entry.name.endsWith('.json')) paths.push(path);
  }
  return paths;
};

export const listFixturePaths = async (): Promise<string[]> =>
  (await collectFixturePaths(new URL('../fixtures/', import.meta.url))).sort();
