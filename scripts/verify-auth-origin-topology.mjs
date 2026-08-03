import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputByteLimit = 64 * 1024;
const expectedKeys = {
  'frontend env': ['NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN', 'NEXT_PUBLIC_BOARD_API_URL'],
  'backend env': ['APP_ENV', 'BOARD_ALLOWED_ORIGINS', 'BOARD_PUBLIC_API_ORIGIN'],
  'runtime env': [
    'ARTIFACT_RUNTIME_API_ORIGIN',
    'ARTIFACT_RUNTIME_APP_ORIGIN',
    'ARTIFACT_RUNTIME_ORIGIN',
  ],
};

const usage =
  'usage: verify-auth-origin-topology.mjs --frontend-env <json> --backend-env <json> --runtime-env <json> --out <json>';

const parseArguments = (arguments_) => {
  if (arguments_.length === 1 && arguments_[0] === '--self-test') return { selfTest: true };
  if (
    arguments_.length !== 8 ||
    arguments_[0] !== '--frontend-env' ||
    arguments_[2] !== '--backend-env' ||
    arguments_[4] !== '--runtime-env' ||
    arguments_[6] !== '--out'
  )
    throw new Error(usage);
  return {
    selfTest: false,
    frontendPath: arguments_[1],
    backendPath: arguments_[3],
    runtimePath: arguments_[5],
    outputPath: arguments_[7],
  };
};

const readCanonicalInput = async (path, label) => {
  if (typeof path !== 'string' || path !== resolve(path))
    throw new Error(`${label} must be one canonical regular file`);
  const [workspace, canonicalPath, before, workspaceMetadata] = await Promise.all([
    realpath(root),
    realpath(path),
    lstat(path, { bigint: true }),
    lstat(root, { bigint: true }),
  ]);
  const offset = relative(workspace, canonicalPath);
  const acceptedOwners = new Set([
    workspaceMetadata.uid,
    ...(process.getuid === undefined ? [] : [BigInt(process.getuid())]),
  ]);
  const invalidReason =
    canonicalPath !== path
      ? 'non-canonical'
      : offset === '' || offset === '..' || offset.startsWith(`..${sep}`)
        ? 'outside-workspace'
        : !before.isFile() || before.isSymbolicLink()
          ? 'not-regular'
          : before.nlink !== 1n
            ? 'linked'
            : before.size > BigInt(inputByteLimit)
              ? 'oversized'
              : !acceptedOwners.has(before.uid)
                ? 'wrong-owner'
                : (before.mode & 0o077n) !== 0n
                  ? 'permissive-mode'
                  : null;
  if (invalidReason !== null)
    throw new Error(`${label} must be one owned private contained regular file: ${invalidReason}`);
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await descriptor.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1n
    )
      throw new Error(`${label} changed while it was acquired`);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    if (
      bytes.length > inputByteLimit ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1n
    )
      throw new Error(`${label} changed while it was read`);
    return bytes;
  } finally {
    await descriptor.close();
  }
};

const parseJsonObject = (bytes, label) => {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys[label]) ||
    bytes.toString('utf8') !== `${canonicalJson(value)}\n`
  )
    throw new Error(`${label} must use the exact canonical schema`);
  return value;
};

const stringField = (object, key) => {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`);
  return value;
};

const canonicalOrigin = (value, key) => {
  if (value !== value.trim() || value.includes(',') || /[^\x20-\x7e]/u.test(value))
    throw new Error(`${key} must be one ASCII origin`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid origin`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  )
    throw new Error(`${key} must be a canonical bare origin`);
  return url;
};

export const verifyAuthOriginTopology = async ({
  frontendPath,
  backendPath,
  runtimePath,
  identity,
  selfTest = false,
} = {}) => {
  const [frontendBytes, backendBytes, runtimeBytes] = selfTest
    ? [
        Buffer.from(
          `${canonicalJson({
            NEXT_PUBLIC_BOARD_API_URL: 'http://127.0.0.1:3411',
            NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:3412',
          })}\n`,
        ),
        Buffer.from(
          `${canonicalJson({
            APP_ENV: 'test',
            BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410',
            BOARD_PUBLIC_API_ORIGIN: 'http://127.0.0.1:3411',
          })}\n`,
        ),
        Buffer.from(
          `${canonicalJson({
            ARTIFACT_RUNTIME_APP_ORIGIN: 'http://127.0.0.1:3410',
            ARTIFACT_RUNTIME_API_ORIGIN: 'http://127.0.0.1:3411',
            ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:3412',
          })}\n`,
        ),
      ]
    : await Promise.all([
        readCanonicalInput(frontendPath, 'frontend env'),
        readCanonicalInput(backendPath, 'backend env'),
        readCanonicalInput(runtimePath, 'runtime env'),
      ]);
  const frontend = parseJsonObject(frontendBytes, 'frontend env');
  const backend = parseJsonObject(backendBytes, 'backend env');
  const runtime = parseJsonObject(runtimeBytes, 'runtime env');
  const appEnv = stringField(backend, 'APP_ENV');
  if (!['development', 'test', 'staging', 'production'].includes(appEnv))
    throw new Error('APP_ENV is invalid');
  if (!selfTest && (identity === undefined || identity.environment !== appEnv))
    throw new Error('APP_ENV differs from the certification attempt environment');

  const frontendApi = canonicalOrigin(
    stringField(frontend, 'NEXT_PUBLIC_BOARD_API_URL'),
    'NEXT_PUBLIC_BOARD_API_URL',
  );
  const frontendRuntime = canonicalOrigin(
    stringField(frontend, 'NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN'),
    'NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN',
  );
  const browser = canonicalOrigin(
    stringField(backend, 'BOARD_ALLOWED_ORIGINS'),
    'BOARD_ALLOWED_ORIGINS',
  );
  const publicApi = canonicalOrigin(
    stringField(backend, 'BOARD_PUBLIC_API_ORIGIN'),
    'BOARD_PUBLIC_API_ORIGIN',
  );
  const runtimeApp = canonicalOrigin(
    stringField(runtime, 'ARTIFACT_RUNTIME_APP_ORIGIN'),
    'ARTIFACT_RUNTIME_APP_ORIGIN',
  );
  const runtimeApi = canonicalOrigin(
    stringField(runtime, 'ARTIFACT_RUNTIME_API_ORIGIN'),
    'ARTIFACT_RUNTIME_API_ORIGIN',
  );
  const runtimeOrigin = canonicalOrigin(
    stringField(runtime, 'ARTIFACT_RUNTIME_ORIGIN'),
    'ARTIFACT_RUNTIME_ORIGIN',
  );
  if (frontendApi.origin !== publicApi.origin)
    throw new Error('frontend and backend public API origins differ');
  if (frontendRuntime.origin !== runtimeOrigin.origin)
    throw new Error('frontend and runtime public origins differ');
  if (runtimeApp.origin !== browser.origin || runtimeApi.origin !== publicApi.origin)
    throw new Error('runtime topology inputs differ from app/API inputs');
  if (runtimeOrigin.origin === browser.origin || runtimeOrigin.origin === publicApi.origin)
    throw new Error('runtime origin must be distinct from app and API');
  if (browser.protocol !== publicApi.protocol || browser.hostname !== publicApi.hostname)
    throw new Error('browser and API origins must share scheme and hostname');
  if (runtimeOrigin.hostname === browser.hostname || runtimeOrigin.hostname === publicApi.hostname)
    throw new Error('runtime must use a separate cookie hostname');
  if (
    ['staging', 'production'].includes(appEnv) &&
    (browser.protocol !== 'https:' ||
      publicApi.protocol !== 'https:' ||
      runtimeOrigin.protocol !== 'https:')
  )
    throw new Error('staging and production require https');
  if (
    ['staging', 'production'].includes(appEnv) &&
    (runtimeOrigin.hostname === browser.hostname || runtimeOrigin.hostname === publicApi.hostname)
  )
    throw new Error('runtime must use a separate cookie hostname');
  if (
    ['development', 'test'].includes(appEnv) &&
    browser.protocol === 'http:' &&
    !['127.0.0.1', '::1'].includes(browser.hostname)
  ) {
    throw new Error('development/test http is limited to loopback');
  }
  if (
    ['development', 'test'].includes(appEnv) &&
    (browser.origin !== 'http://127.0.0.1:3410' ||
      publicApi.origin !== 'http://127.0.0.1:3411' ||
      runtimeOrigin.origin !== 'http://127.0.0.2:3412')
  ) {
    throw new Error('local topology must use the frozen 3410/3411/3412 origins');
  }

  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + 15 * 60 * 1_000);
  const evidence = {
    schemaVersion: selfTest
      ? 'auth-artifact-origin-evidence/self-test-v1'
      : 'auth-artifact-origin-evidence/v3',
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    frontendOrigin: browser.origin,
    apiOrigin: publicApi.origin,
    runtimeOrigin: runtimeOrigin.origin,
    appEnv,
    frontendInputSha256: createHash('sha256').update(frontendBytes).digest('hex'),
    backendInputSha256: createHash('sha256').update(backendBytes).digest('hex'),
    runtimeInputSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
    ...(selfTest
      ? {}
      : {
          identity,
          target: {
            kind: 'submitted-deployment-topology',
            bindingSha256: sha256(
              canonicalJson({
                identity,
                frontendOrigin: browser.origin,
                apiOrigin: publicApi.origin,
                runtimeOrigin: runtimeOrigin.origin,
                frontendInputSha256: createHash('sha256').update(frontendBytes).digest('hex'),
                backendInputSha256: createHash('sha256').update(backendBytes).digest('hex'),
                runtimeInputSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
              }),
            ),
          },
        }),
  };
  return evidence;
};

const main = async () => {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (!arguments_.selfTest)
    throw new Error(
      'release topology verification is available only through an owned certification attempt',
    );
  process.stdout.write(
    `${JSON.stringify(await verifyAuthOriginTopology({ selfTest: true }), null, 2)}\n`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'origin preflight failed'}\n`);
    process.exitCode = 1;
  });
