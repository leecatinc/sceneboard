import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const configPath = join(projectRoot, 'config/offline-package-sources.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const bundleRoot = resolve(config.bundleRoot);
const tarballRoot = join(bundleRoot, 'tarballs');
const manifestRoot = join(bundleRoot, 'manifests');
const indexPath = join(bundleRoot, 'registry-index.json');
const candidates = new Map();
const packed = new Map();

function versionParts(version) {
  const [core, pre = ''] = String(version).replace(/^v/, '').split('-', 2);
  return { nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
}

function compareVersions(a, b) {
  const av = versionParts(a);
  const bv = versionParts(b);
  for (let index = 0; index < Math.max(av.nums.length, bv.nums.length); index += 1) {
    const delta = (av.nums[index] || 0) - (bv.nums[index] || 0);
    if (delta !== 0) return delta;
  }
  if (!av.pre && bv.pre) return 1;
  if (av.pre && !bv.pre) return -1;
  return av.pre.localeCompare(bv.pre);
}

async function addPackage(packageDir) {
  let canonicalDir;
  try {
    canonicalDir = await realpath(packageDir);
  } catch {
    return;
  }
  try {
    const manifest = JSON.parse(await readFile(join(canonicalDir, 'package.json'), 'utf8'));
    if (!manifest.name || !manifest.version) return;
    const versions = candidates.get(manifest.name) || new Map();
    if (!versions.has(manifest.version)) {
      versions.set(manifest.version, { packageDir: canonicalDir, manifest });
      candidates.set(manifest.name, versions);
    }
    await scanNodeModules(join(canonicalDir, 'node_modules'));
  } catch {
    // A missing or invalid package manifest is not a source candidate.
  }
}

async function scanPnpmStore(pnpmRoot) {
  let entries;
  try {
    entries = await readdir(pnpmRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await scanNodeModules(join(pnpmRoot, entry.name, 'node_modules'));
  }
}

async function scanNodeModules(nodeModulesRoot) {
  let entries;
  try {
    entries = await readdir(nodeModulesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.bin') continue;
    if (entry.name === '.pnpm') {
      await scanPnpmStore(join(nodeModulesRoot, entry.name));
      continue;
    }
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = await readdir(join(nodeModulesRoot, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        await addPackage(join(nodeModulesRoot, entry.name, child.name));
      }
      continue;
    }
    await addPackage(join(nodeModulesRoot, entry.name));
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function sha512Integrity(filePath) {
  const bytes = await readFile(filePath);
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function tarballKey(name, version) {
  return `${encodeURIComponent(name)}-${version}.tgz`;
}

async function packVersion(name, version, candidate) {
  const key = `${name}@${version}`;
  if (packed.has(key)) return packed.get(key);
  const fileName = tarballKey(name, version);
  const destination = join(tarballRoot, fileName);
  await rm(destination, { force: true });
  await run('tar', [
    '--create',
    '--gzip',
    '--file', destination,
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--transform=s,^\\./,package/,',
    '--exclude=./node_modules',
    '--directory', candidate.packageDir,
    '.',
  ]);
  const record = {
    name,
    version,
    sourcePath: candidate.packageDir,
    tarball: `tarballs/${fileName}`,
    integrity: await sha512Integrity(destination),
    shasum: createHash('sha1').update(await readFile(destination)).digest('hex'),
  };
  packed.set(key, record);
  return record;
}

async function buildPackument(name) {
  const versions = candidates.get(name);
  if (!versions) return null;
  const document = { name, 'dist-tags': {}, versions: {} };
  const sorted = [...versions.keys()].sort(compareVersions);
  for (const version of sorted) {
    const candidate = versions.get(version);
    const record = await packVersion(name, version, candidate);
    const manifest = {
      ...candidate.manifest,
      dist: {
        integrity: record.integrity,
        shasum: record.shasum,
        tarball: `${config.registryOrigin}/-/tarballs/${basename(record.tarball)}`,
      },
    };
    document.versions[version] = manifest;
    await writeFile(join(manifestRoot, `${encodeURIComponent(name)}-${version}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  document['dist-tags'].latest = sorted.at(-1);
  return document;
}

async function writeIndex() {
  const records = [...packed.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const payload = {
    schemaVersion: 1,
    registryOrigin: config.registryOrigin,
    generatedAt: new Date().toISOString(),
    sourceNodeModules: config.sourceNodeModules,
    packages: records,
  };
  await writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`);
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(tarballRoot, { recursive: true });
await mkdir(manifestRoot, { recursive: true });
for (const source of config.sourceNodeModules) await scanNodeModules(source);

const origin = new URL(config.registryOrigin);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', config.registryOrigin);
    if (url.pathname.startsWith('/-/tarballs/')) {
      const filePath = join(tarballRoot, basename(url.pathname));
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFile(filePath));
      return;
    }
    const rawName = decodeURIComponent(url.pathname.slice(1));
    const name = rawName.startsWith('@') && !rawName.includes('/')
      ? rawName.replace('%2f', '/').replace('%2F', '/')
      : rawName;
    const packument = await buildPackument(name);
    if (!packument) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `package_not_in_approved_local_sources:${name}` }));
      return;
    }
    await writeIndex();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(packument));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(Number(origin.port), origin.hostname, async () => {
  await writeIndex();
  process.stdout.write(`OFFLINE_REGISTRY_READY ${config.registryOrigin} candidates=${candidates.size}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
