import { createHash, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const approval = JSON.parse(await readFile(join(projectRoot, 'dependency-source.approval.v1.json'), 'utf8'));
const attestation = JSON.parse(await readFile(join(projectRoot, 'dependency-source.attestation.v1.json'), 'utf8'));
const trust = JSON.parse(await readFile(join(projectRoot, 'test/certification/policy/dependency-approval-trust.v1.json'), 'utf8'));

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(approval.schemaVersion === 1, 'approval_schema_invalid');
assert(approval.signedPayload?.status === 'approved' && approval.signedPayload?.revokedAt === null, 'approval_not_active');
assert(approval.signature?.algorithm === 'Ed25519', 'approval_algorithm_invalid');
assert(approval.signature?.keyId === trust.keyId, 'approval_key_mismatch');
assert(verify(
  null,
  Buffer.from(canonicalize(approval.signedPayload)),
  trust.publicKeyPem,
  Buffer.from(approval.signature.valueBase64url, 'base64url'),
), 'approval_signature_invalid');

const lockfilePath = join(projectRoot, 'package-lock.json');
const lockfileBytes = await readFile(lockfilePath);
assert(sha256(lockfileBytes) === approval.signedPayload.lockfileSha256, 'lockfile_hash_mismatch');
const lockfile = JSON.parse(lockfileBytes);
for (const [packagePath, record] of Object.entries(lockfile.packages || {})) {
  if (!record?.resolved) continue;
  const localWorkspace = ['leecat-board-nextjs', 'leecat-board-nestjs', 'leecat-board-mcp', 'packages/'].some((prefix) => record.resolved === prefix || record.resolved.startsWith(prefix));
  assert(localWorkspace || record.resolved.startsWith('http://127.0.0.1:4873/-/tarballs/'), `forbidden_lock_source:${packagePath}`);
}

const bundleRoot = approval.signedPayload.sourceLocator;
const manifestPath = join(bundleRoot, 'bundle-manifest.sha256');
const manifestBytes = await readFile(manifestPath);
assert(sha256(manifestBytes) === attestation.source.bundleManifestSha256, 'bundle_manifest_hash_mismatch');
assert(sha256(manifestBytes) === approval.signedPayload.sourcePayloadSha256, 'bundle_payload_hash_mismatch');
for (const line of String(manifestBytes).trim().split('\n')) {
  const match = line.match(/^([a-f0-9]{64})  (.+)$/);
  assert(match, 'bundle_manifest_row_invalid');
  assert(sha256(await readFile(join(bundleRoot, match[2]))) === match[1], `bundle_file_hash_mismatch:${match[2]}`);
}

const approvalBytes = await readFile(join(projectRoot, 'dependency-source.approval.v1.json'));
assert(sha256(approvalBytes) === attestation.approvalRecord.sha256, 'approval_record_hash_mismatch');
for (const filePath of [
  bundleRoot,
  join(bundleRoot, 'tarballs'),
  join(bundleRoot, 'manifests'),
]) {
  const mode = (await stat(filePath)).mode & 0o777;
  assert((mode & 0o222) === 0, `bundle_path_is_writable:${filePath}`);
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  approvedDependencyBaselineSha256: approval.signedPayload.approvedDependencyBaselineSha256,
  lockfileSha256: approval.signedPayload.lockfileSha256,
  sourcePayloadSha256: approval.signedPayload.sourcePayloadSha256,
  packageCount: Object.keys(lockfile.packages || {}).length,
}, null, 2)}\n`);
