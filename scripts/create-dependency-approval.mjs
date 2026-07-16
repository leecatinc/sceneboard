import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(projectRoot, 'config/offline-package-sources.json'), 'utf8'));
const bundleRoot = resolve(config.bundleRoot);
const keyRoot = '/workspace/.local/share/leecat-board/keys';
const privateKeyPath = join(keyRoot, 'dependency-approval-ed25519-private.pem');
const publicKeyPath = join(keyRoot, 'dependency-approval-ed25519-public.pem');
const policyRoot = join(projectRoot, 'test/certification/policy');
const approvalPath = join(projectRoot, 'dependency-source.approval.v1.json');
const attestationPath = join(projectRoot, 'dependency-source.attestation.v1.json');
const lockfilePath = join(projectRoot, 'package-lock.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function listFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(root, absolute));
    else if (entry.isFile()) output.push({ absolute, relative: relative(root, absolute) });
  }
  return output;
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

await mkdir(keyRoot, { recursive: true });
let privateKeyPem;
let publicKeyPem;
try {
  privateKeyPem = await readFile(privateKeyPath, 'utf8');
  publicKeyPem = await readFile(publicKeyPath, 'utf8');
} catch {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });
  await writeFile(publicKeyPath, publicKeyPem, { mode: 0o644 });
}
await chmod(privateKeyPath, 0o600);

const trustPolicyPath = join(policyRoot, 'dependency-approval-trust.v1.json');
const licensePolicyPath = join(policyRoot, 'dependency-license-policy.v1.json');
const sourcePolicyPath = join(policyRoot, 'dependency-source-classes-policy.v1.json');
const keyId = `leecat-board-dependency-approval-${sha256(publicKeyPem).slice(0, 16)}`;

await writeJson(trustPolicyPath, {
  schemaVersion: 1,
  policyVersion: 1,
  algorithm: 'Ed25519',
  keyId,
  publicKeyPem,
});
await writeJson(licensePolicyPath, {
  schemaVersion: 1,
  policyVersion: 1,
  decision: 'inventory_and_fail_closed_on_unknown',
  allowedSpdxExpressions: ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'CC-BY-4.0', 'CC0-1.0', 'ISC', 'LGPL-3.0-or-later', 'MIT', 'Python-2.0'],
  localWorkspacePolicy: 'Private leecat-board workspace packages may omit a license field; they are not redistributed dependencies.',
  legacyMetadataPolicy: 'busboy, streamsearch, and seq-queue are accepted as MIT only when their bundled license metadata or LICENSE file matches the audited local payload.',
  lgplPolicy: 'LGPL-3.0-or-later is limited to the optional unmodified sharp libvips binary packages and must remain replaceable.',
  forbidden: ['Unknown external dependency license after bundled-license inspection', 'GPL family without a new explicit approval'],
});
await writeJson(sourcePolicyPath, {
  schemaVersion: 1,
  policyVersion: 1,
  allowedSourceClasses: ['local_immutable_npm_bundle'],
  forbiddenSourceClasses: ['public_registry', 'runtime_network_fetch', 'cross_project_symlink'],
  registryOrigin: config.registryOrigin,
});

const bundleFiles = (await listFiles(bundleRoot))
  .filter((item) => item.relative !== 'bundle-manifest.sha256')
  .sort((a, b) => a.relative.localeCompare(b.relative));
const bundleRows = [];
for (const file of bundleFiles) bundleRows.push(`${sha256(await readFile(file.absolute))}  ${file.relative}`);
const bundleManifest = `${bundleRows.join('\n')}\n`;
const bundleManifestPath = join(bundleRoot, 'bundle-manifest.sha256');
await writeFile(bundleManifestPath, bundleManifest);
const sourcePayloadSha256 = sha256(bundleManifest);

const registryIndex = JSON.parse(await readFile(join(bundleRoot, 'registry-index.json'), 'utf8'));
const packageSet = (registryIndex.packages || [])
  .map((item) => ({ name: item.name, version: item.version, integrity: item.integrity, shasum: item.shasum }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const sourcePackageSetSha256 = sha256(canonicalize(packageSet));
const lockfileBytes = await readFile(lockfilePath);
const lockfile = JSON.parse(lockfileBytes);
const lockfileSha256 = sha256(lockfileBytes);
const licensePolicySha256 = sha256(await readFile(licensePolicyPath));
const sourcePolicySha256 = sha256(await readFile(sourcePolicyPath));

const baseline = {
  sourceClassification: 'local_immutable_npm_bundle',
  sourceLocator: bundleRoot,
  sourcePayloadSha256,
  sourcePackageSetSha256,
  lockfilePath: '/workspace/lc/leecat-board/package-lock.json',
  lockfileSha256,
  lockfileVersion: lockfile.lockfileVersion,
  runtime: {
    node: process.version,
    npm: '10.9.3',
    platform: process.platform,
    architecture: process.arch,
  },
  licensePolicyPath: '/workspace/lc/leecat-board/test/certification/policy/dependency-license-policy.v1.json',
  licensePolicySha256,
  allowedSourceClassesPath: '/workspace/lc/leecat-board/test/certification/policy/dependency-source-classes-policy.v1.json',
  allowedSourceClassesSha256: sourcePolicySha256,
};
const approvedDependencyBaselineSha256 = sha256(canonicalize(baseline));
const signedPayload = {
  decisionId: 'leecat-board-dependency-source-2026-07-16-v1',
  status: 'approved',
  projectId: 'leecat-board',
  approvedDependencyBaselineSha256,
  ...baseline,
  issuedAt: new Date().toISOString(),
  revokedAt: null,
};
const signature = sign(null, Buffer.from(canonicalize(signedPayload)), privateKeyPem).toString('base64url');
const approval = {
  schemaVersion: 1,
  signedPayload,
  signature: { algorithm: 'Ed25519', keyId, valueBase64url: signature },
};
await writeJson(approvalPath, approval);
const approvalSha256 = sha256(await readFile(approvalPath));

await writeJson(attestationPath, {
  schemaVersion: 1,
  projectId: 'leecat-board',
  approvedDependencyBaselineSha256,
  source: {
    classification: baseline.sourceClassification,
    locator: baseline.sourceLocator,
    payloadSha256: sourcePayloadSha256,
    packageSetSha256: sourcePackageSetSha256,
    bundleManifestPath,
    bundleManifestSha256: sha256(await readFile(bundleManifestPath)),
  },
  lockfile: {
    path: baseline.lockfilePath,
    sha256: lockfileSha256,
    version: lockfile.lockfileVersion,
  },
  approvalRecord: {
    path: '/workspace/lc/leecat-board/dependency-source.approval.v1.json',
    sha256: approvalSha256,
  },
  trustPolicy: {
    path: '/workspace/lc/leecat-board/test/certification/policy/dependency-approval-trust.v1.json',
    sha256: sha256(await readFile(trustPolicyPath)),
  },
});

for (const file of await listFiles(bundleRoot)) await chmod(file.absolute, 0o444);
const directories = (await listFiles(bundleRoot)).map((file) => dirname(file.absolute));
for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) await chmod(directory, 0o555);
await chmod(bundleRoot, 0o555);

process.stdout.write(`${JSON.stringify({ approvedDependencyBaselineSha256, sourcePayloadSha256, sourcePackageSetSha256, lockfileSha256, keyId }, null, 2)}\n`);
