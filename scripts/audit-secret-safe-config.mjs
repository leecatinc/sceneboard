import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CertificationError,
  readJson,
  safeResult,
  sha256,
} from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['.mcp.json', 'mcp-config'],
  ['.npmrc', 'npm-config'],
  ['sceneboard-fe/.env.example', 'example-env'],
  ['sceneboard-be/.env.example', 'example-env'],
  ['packages/artifact-runtime/.env.example', 'example-env'],
];

const repositoryState = (path) => {
  const options = { cwd: root, stdio: 'ignore' };
  const ignoredStatus = spawnSync('git', ['check-ignore', '--quiet', '--', path], options).status;
  const trackedStatus = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', path],
    options,
  ).status;
  return {
    path,
    ignored: ignoredStatus === 0,
    tracked: trackedStatus === 0,
    verifiable: [0, 1].includes(ignoredStatus) && [0, 1].includes(trackedStatus),
  };
};

const fileRecord = async ([path, classification]) => {
  try {
    const [metadata, bytes] = await Promise.all([
      lstat(resolve(root, path)),
      readFile(resolve(root, path)),
    ]);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new CertificationError('SECRET_FILE_MODE_OR_OWNER_UNSAFE');
    return {
      path,
      exists: true,
      classification,
      modeClass: (metadata.mode & 0o077) === 0 ? 'owner-only' : 'shared-readable',
      ownerClass: metadata.uid === process.getuid?.() ? 'current-user' : 'other-owner',
      sha256: sha256(bytes),
    };
  } catch (error) {
    if (error?.code === 'ENOENT')
      return {
        path,
        exists: false,
        classification,
        modeClass: 'absent',
        ownerClass: 'absent',
        sha256: null,
      };
    throw error;
  }
};

const envKeyClasses = async (path) => {
  const source = await readFile(resolve(root, path), 'utf8');
  return source
    .split(/\r?\n/gu)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => line.slice(0, line.indexOf('=')))
    .map((keyPath) => ({
      keyPath,
      classification: /(?:PASSWORD|SECRET|TOKEN|KEY|PEPPER)(?:_B64)?$/u.test(keyPath)
        ? 'secret-reference'
        : 'non-secret-config',
    }));
};

export const auditSecretSafeConfig = async () => {
  const files = await Promise.all(targets.map(fileRecord));
  const keyPaths = [];
  for (const [path, classification] of targets) {
    if (classification === 'example-env')
      keyPaths.push(...(await envKeyClasses(path)).map((entry) => ({ path, ...entry })));
  }
  const findings = [];
  const exceptions = [];
  const mcpFile = files.find(({ path }) => path === '.mcp.json');
  const mcpRepositoryState = repositoryState('.mcp.json');
  if (mcpFile?.exists === false) {
    exceptions.push({
      path: '.mcp.json',
      classification: 'local-only-config',
      reason: 'ABSENT_LOCAL_CONFIG',
    });
  } else if (
    mcpRepositoryState.verifiable &&
    mcpRepositoryState.ignored &&
    !mcpRepositoryState.tracked
  ) {
    exceptions.push({
      ...mcpRepositoryState,
      classification: 'local-only-config',
      reason: 'IGNORED_UNTRACKED_LOCAL_CONFIG',
    });
  } else {
    const { value: mcp } = await readJson(resolve(root, '.mcp.json'));
    if (
      mcp === null ||
      typeof mcp !== 'object' ||
      Array.isArray(mcp) ||
      mcp.mcpServers === null ||
      typeof mcp.mcpServers !== 'object' ||
      Array.isArray(mcp.mcpServers)
    ) {
      findings.push({
        path: '.mcp.json',
        classification: 'invalid-structure',
        reason: 'SIBLING_SECRET_SOURCE_UNRESOLVED',
      });
    } else {
      for (const value of Object.values(mcp.mcpServers)) {
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.command === 'npx'
        ) {
          findings.push({
            path: '.mcp.json',
            classification: 'network-dependent-runner',
            reason: 'FORBIDDEN_NETWORK_RUNNER',
          });
        }
      }
    }
  }
  const npmrc = await readFile(resolve(root, '.npmrc'), 'utf8');
  if (/\b(?:_authToken|_password|username)\s*=/iu.test(npmrc)) {
    findings.push({
      path: '.npmrc',
      classification: 'credential-bearing-config',
      reason: 'INLINE_SECRET_DETECTED',
    });
  }
  const status = findings.length === 0 ? 'PASS' : 'BLOCKED';
  return safeResult(status, { mode: 'secret-safe', files, keyPaths, exceptions, findings });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditSecretSafeConfig();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'PASS') process.exitCode = 2;
  } catch (error) {
    const reason =
      error instanceof CertificationError ? error.code : 'SIBLING_SECRET_SOURCE_UNRESOLVED';
    process.stdout.write(
      `${JSON.stringify(
        safeResult('BLOCKED', {
          mode: 'secret-safe',
          findings: [
            {
              path: 'configuration',
              classification: 'audit-failure',
              reason,
            },
          ],
        }),
      )}\n`,
    );
    process.exitCode = 2;
  }
}
