import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(projectRoot, 'config/offline-package-sources.json'), 'utf8'));
const bundleRoot = resolve(config.bundleRoot);
const index = JSON.parse(await readFile(join(bundleRoot, 'registry-index.json'), 'utf8'));
const packages = new Map();

for (const record of index.packages || []) {
  const versions = packages.get(record.name) || [];
  versions.push(record);
  packages.set(record.name, versions);
}

function compareVersions(a, b) {
  return a.version.localeCompare(b.version, 'en', { numeric: true });
}

const origin = new URL(config.registryOrigin);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', config.registryOrigin);
    if (url.pathname.startsWith('/-/tarballs/')) {
      const filePath = join(bundleRoot, 'tarballs', basename(url.pathname));
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFile(filePath));
      return;
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const records = packages.get(name);
    if (!records?.length) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `package_not_in_frozen_source:${name}` }));
      return;
    }
    const versions = {};
    const sorted = [...records].sort(compareVersions);
    for (const record of sorted) {
      const manifest = JSON.parse(await readFile(join(bundleRoot, 'manifests', `${encodeURIComponent(record.name)}-${record.version}.json`), 'utf8'));
      versions[record.version] = manifest;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name, 'dist-tags': { latest: sorted.at(-1).version }, versions }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(Number(origin.port), origin.hostname, () => {
  process.stdout.write(`OFFLINE_REGISTRY_READY ${config.registryOrigin} frozen=true\n`);
});
