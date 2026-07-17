import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertificationError, safeResult, sha256 } from './lib/certification/canonical-json.mjs';
import { auditSecretSafeConfig } from './audit-secret-safe-config.mjs';
import { verifyContractManifest } from './verify-contract-manifest.mjs';
import { verifyDependencies } from './verify-dependency-reproducibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phases = new Set([
  'database', 'restore', 'redis-loss', 'multi-client', 'security', 'e2e', 'operations', 'capacity', 'release',
]);
const phaseArguments = {
  database: new Set(['phase', 'mode', 'scenario']),
  restore: new Set(['phase', 'profile']),
  'redis-loss': new Set(['phase', 'profile']),
  'multi-client': new Set(['phase', 'profile']),
  security: new Set(['phase', 'profile']),
  e2e: new Set(['phase', 'profile']),
  operations: new Set(['phase', 'profile']),
  capacity: new Set(['phase', 'profile']),
  release: new Set(['phase', 'profile']),
};

export const parseCertificationArguments = (argumentsList) => {
  const values = {};
  for (const argument of argumentsList) {
    const match = /^--([a-z-]+)=([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(argument);
    if (!match || match[1] in values) throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    values[match[1]] = match[2];
  }
  if (!phases.has(values.phase) || Object.keys(values).some((key) => !phaseArguments[values.phase].has(key))) {
    throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  }
  if (values.phase === 'database') {
    if (!['full-offline', 'bounded-restart', 'resumable-audit'].includes(values.mode)) {
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    }
    if (values.mode === 'full-offline' && !['fresh', 'adopt'].includes(values.scenario)) {
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    }
    if (values.mode !== 'full-offline' && values.scenario !== undefined) throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  } else if (values.phase === 'restore') {
    if (values.profile !== 'quarantine') throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  } else if (values.phase === 'release') {
    if (values.profile !== 'non-production') throw new CertificationError('PRODUCTION_TARGET_FORBIDDEN');
  } else if (!['isolated', 'representative', 'non-production', 'full-local'].includes(values.profile)
    || (values.profile === 'full-local' && values.phase !== 'e2e')) {
    throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  }
  return values;
};

const git = (args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

export const attestCleanSource = () => {
  let certificationSourceCommit;
  let headTreeSha256;
  let indexTreeSha256;
  let status;
  try {
    certificationSourceCommit = git(['rev-parse', 'HEAD']);
    headTreeSha256 = git(['rev-parse', 'HEAD^{tree}']);
    indexTreeSha256 = git(['write-tree']);
    status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  } catch {
    throw new CertificationError('SOURCE_TREE_DIRTY_OR_UNATTESTED');
  }
  if (headTreeSha256 !== indexTreeSha256 || status !== '') {
    throw new CertificationError('SOURCE_TREE_DIRTY_OR_UNATTESTED');
  }
  return {
    schemaVersion: 1,
    certificationSourceCommit,
    headTreeSha256,
    indexTreeSha256,
    statusSha256: sha256(status),
    generatedParents: ['.artifacts/certification', '.certification-fixtures'],
  };
};

export const runCertificationPreflight = async (options) => {
  const source = attestCleanSource();
  const dependency = await verifyDependencies({ profile: 'static' });
  const config = await auditSecretSafeConfig();
  if (config.status !== 'PASS') {
    throw new CertificationError(config.findings[0]?.reason ?? 'SIBLING_SECRET_SOURCE_UNRESOLVED');
  }
  const contract = await verifyContractManifest();
  if (process.env.SCENEBOARD_CERTIFICATION_LIVE_ADAPTER !== 'approved-local-v1') {
    throw new CertificationError('CERTIFICATION_ENVIRONMENT_UNAVAILABLE');
  }
  return { options, source, dependency, config, contract };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseCertificationArguments(process.argv.slice(2));
    await runCertificationPreflight(options);
    process.stdout.write(`${JSON.stringify(safeResult('BLOCKED', {
      phase: options.phase,
      reason: 'LIVE_CERTIFICATION_ADAPTER_NOT_IMPLEMENTED',
    }))}\n`);
    process.exitCode = 2;
  } catch (error) {
    const reason = error instanceof CertificationError ? error.code : 'CERTIFICATION_PREFLIGHT_FAILED';
    process.stdout.write(`${JSON.stringify(safeResult('BLOCKED', {
      phase: options?.phase ?? 'argument-validation',
      reason,
    }))}\n`);
    process.exitCode = 2;
  }
}
