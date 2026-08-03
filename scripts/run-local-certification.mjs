import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationError,
  containsSecretLikeMaterial,
  safeResult,
  sha256,
} from './lib/certification/canonical-json.mjs';
import { auditSecretSafeConfig } from './audit-secret-safe-config.mjs';
import {
  aiExportManifestSha256,
  createMigrationCertificationEnvironment,
  createRestoreCertificationEnvironment,
  produceAiExportCertification,
  readOwnedCanonicalJsonInput,
  validateDatabaseBoundaryReport,
  validateRestoreLiveReport,
} from './certify-ai-export-contracts.mjs';
import { verifyContractManifest } from './verify-contract-manifest.mjs';
import { verifyDependencies } from './verify-dependency-reproducibility.mjs';
import { finalizeAiExportCertification } from './verify-ai-export-certification.mjs';
import {
  createCertificationChildEnvironment,
  createGitCertificationEnvironment,
} from './lib/certification/process-lifecycle.mjs';
import { validateSecurityLiveEvidence } from './lib/certification/security-catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phases = new Set([
  'database',
  'restore',
  'redis-loss',
  'multi-client',
  'security',
  'e2e',
  'operations',
  'capacity',
  'release',
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
    if (!match || match[1] in values)
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    values[match[1]] = match[2];
  }
  if (
    !phases.has(values.phase) ||
    Object.keys(values).some((key) => !phaseArguments[values.phase].has(key))
  ) {
    throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  }
  if (values.phase === 'database') {
    if (!['full-offline', 'bounded-restart', 'resumable-audit'].includes(values.mode)) {
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    }
    if (values.mode === 'full-offline' && !['fresh', 'adopt'].includes(values.scenario)) {
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
    }
    if (values.mode !== 'full-offline' && values.scenario !== undefined)
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  } else if (values.phase === 'restore') {
    if (values.profile !== 'quarantine')
      throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  } else if (values.phase === 'release') {
    if (values.profile !== 'non-production')
      throw new CertificationError('PRODUCTION_TARGET_FORBIDDEN');
  } else if (
    !['isolated', 'representative', 'non-production', 'full-local'].includes(values.profile) ||
    (values.profile === 'full-local' && values.phase !== 'e2e')
  ) {
    throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  }
  return values;
};

const git = (args) =>
  execFileSync('git', args, {
    cwd: root,
    env: createGitCertificationEnvironment(process.env),
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

export const runReleaseCertification = async (
  options,
  {
    preflight = runCertificationPreflight,
    produce = produceAiExportCertification,
    finalize = finalizeAiExportCertification,
    environment = process.env.APP_ENV,
  } = {},
) => {
  if (options.phase !== 'release' || options.profile !== 'non-production')
    throw new CertificationError('CERTIFICATION_ARGUMENT_INVALID');
  const prepared = await preflight(options);
  if (!['development', 'test', 'staging'].includes(environment))
    throw new CertificationError('CERTIFICATION_ENVIRONMENT_UNAVAILABLE');
  const produced = await produce({
    workspaceRoot: root,
    sourceCommit: prepared.source.certificationSourceCommit,
    profile: options.profile,
    environment,
  });
  const verified = await finalize(produced);
  return { preflight: prepared, ...verified };
};

const runPhaseProcess = (command, args, environment, input) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const secretDetected = containsSecretLikeMaterial(stdout) || containsSecretLikeMaterial(stderr);
  return {
    status: result.status === 0 && !secretDetected ? 'PASS' : 'BLOCKED',
    exitCode: result.status ?? 1,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    reason:
      result.status === 0 && !secretDetected
        ? 'PHASE_EVIDENCE_VERIFIED'
        : secretDetected
          ? 'SECRET_LIKE_COMMAND_OUTPUT'
          : 'LIVE_CERTIFICATION_COMMAND_FAILED',
  };
};

export const runNamedCertificationPhase = async (options, environment = process.env) => {
  if (options.phase === 'database') {
    const attemptId = environment.SCENEBOARD_CERTIFICATION_ATTEMPT_ID;
    if (typeof attemptId !== 'string' || attemptId === '')
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason: 'DATABASE_LIVE_IDENTITY_MISSING',
      });
    const staticAssertions = runPhaseProcess(
      process.execPath,
      ['--test', 'test/integration/database-certification.test.mjs'],
      createCertificationChildEnvironment(environment),
    );
    if (staticAssertions.status !== 'PASS') return staticAssertions;
    let migrationEnvironment;
    try {
      migrationEnvironment = createMigrationCertificationEnvironment(attemptId, environment);
    } catch (error) {
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason:
          error instanceof CertificationError ? error.code : 'DATABASE_LIVE_ENVIRONMENT_INVALID',
      });
    }
    const liveBoundary = runPhaseProcess(
      process.execPath,
      ['scripts/certify-migration-027.mjs'],
      migrationEnvironment,
    );
    let evidence;
    if (liveBoundary.status === 'PASS') {
      try {
        evidence = validateDatabaseBoundaryReport(liveBoundary.stdout, attemptId);
      } catch (error) {
        return safeResult('BLOCKED', {
          phase: options.phase,
          reason:
            error instanceof CertificationError ? error.code : 'DATABASE_BOUNDARY_EVIDENCE_INVALID',
          staticAssertionsStatus: 'PASS',
          scenarios: [],
        });
      }
    }
    return {
      ...liveBoundary,
      phase: options.phase,
      staticAssertionsStatus: 'PASS',
      scenarios: evidence?.scenarios ?? [],
      databaseOwnerSha256: evidence?.databaseOwnerSha256 ?? null,
      terminalVersion: evidence?.terminalVersion ?? null,
      cleanupStatus: evidence?.cleanupStatus ?? 'BLOCKED',
    };
  }
  if (options.phase === 'restore') {
    const attemptId = environment.SCENEBOARD_CERTIFICATION_ATTEMPT_ID;
    if (typeof attemptId !== 'string' || attemptId === '')
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason: 'RESTORE_LIVE_IDENTITY_MISSING',
      });
    let restoreEnvironment;
    try {
      restoreEnvironment = createRestoreCertificationEnvironment(attemptId, environment);
    } catch (error) {
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason:
          error instanceof CertificationError ? error.code : 'RESTORE_LIVE_ENVIRONMENT_INVALID',
      });
    }
    const run = runPhaseProcess(
      process.execPath,
      ['scripts/sceneboard-retention-restore-drill.mjs', '--produce'],
      restoreEnvironment,
    );
    if (run.status !== 'PASS') return { ...run, phase: options.phase };
    try {
      const evidence = validateRestoreLiveReport(run.stdout, attemptId);
      return { ...run, phase: options.phase, evidence };
    } catch (error) {
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason: error instanceof CertificationError ? error.code : 'RESTORE_LIVE_EVIDENCE_INVALID',
      });
    }
  }
  if (options.phase === 'security') {
    const evidencePath = environment.SCENEBOARD_SECURITY_LIVE_EVIDENCE_JSON;
    if (typeof evidencePath !== 'string' || evidencePath === '')
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason: 'SECURITY_LIVE_EVIDENCE_MISSING',
      });
    const input = readOwnedCanonicalJsonInput(evidencePath, 'SECURITY_LIVE_EVIDENCE_INVALID');
    const catalog = JSON.parse(
      readFileSync(resolve(root, 'test/certification/security-case-catalog.v1.json'), 'utf8'),
    );
    const identity = {
      sourceCommit: environment.SCENEBOARD_CERTIFICATION_SOURCE_COMMIT,
      manifestSha256: aiExportManifestSha256(),
      profile: 'non-production',
      environment: environment.APP_ENV,
      attemptId: environment.SCENEBOARD_CERTIFICATION_ATTEMPT_ID,
    };
    if (
      !/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? '') ||
      !['development', 'test', 'staging'].includes(identity.environment) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.attemptId ?? '')
    ) {
      return safeResult('BLOCKED', {
        phase: options.phase,
        reason: 'SECURITY_LIVE_TRUSTED_IDENTITY_MISSING',
      });
    }
    const validated = validateSecurityLiveEvidence(catalog, input.value, identity, input.bytes, {
      producerKey: environment.SCENEBOARD_SECURITY_PRODUCER_HMAC_KEY,
    });
    return validated.details;
  }
  return safeResult('BLOCKED', {
    phase: options.phase,
    reason: 'LIVE_CERTIFICATION_ADAPTER_NOT_IMPLEMENTED',
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseCertificationArguments(process.argv.slice(2));
    if (options.phase === 'release') {
      const result = await runReleaseCertification(options);
      process.stdout.write(`${JSON.stringify(result.rollup)}\n`);
      if (result.rollup.status !== 'PASS') process.exitCode = 2;
    } else {
      await runCertificationPreflight(options);
      const result = await runNamedCertificationPhase(options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== 'PASS') process.exitCode = 2;
    }
  } catch (error) {
    const reason =
      error instanceof CertificationError ? error.code : 'CERTIFICATION_PREFLIGHT_FAILED';
    process.stdout.write(
      `${JSON.stringify(
        safeResult('BLOCKED', {
          phase: options?.phase ?? 'argument-validation',
          reason,
        }),
      )}\n`,
    );
    process.exitCode = 2;
  }
}
