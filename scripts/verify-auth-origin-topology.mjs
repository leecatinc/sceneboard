import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const usage =
  'usage: verify-auth-origin-topology.mjs --frontend-env <json> --backend-env <json> --runtime-env <json> --out <json>';

const parseArguments = (arguments_) => {
  if (
    arguments_.length !== 8 ||
    arguments_[0] !== '--frontend-env' ||
    arguments_[2] !== '--backend-env' ||
    arguments_[4] !== '--runtime-env' ||
    arguments_[6] !== '--out'
  )
    throw new Error(usage);
  return {
    frontendPath: arguments_[1],
    backendPath: arguments_[3],
    runtimePath: arguments_[5],
    outputPath: arguments_[7],
  };
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

const main = async () => {
  const { frontendPath, backendPath, runtimePath, outputPath } = parseArguments(
    process.argv.slice(2),
  );
  const [frontendBytes, backendBytes, runtimeBytes] = await Promise.all([
    readFile(frontendPath),
    readFile(backendPath),
    readFile(runtimePath),
  ]);
  const frontend = parseJsonObject(frontendBytes, 'frontend env');
  const backend = parseJsonObject(backendBytes, 'backend env');
  const runtime = parseJsonObject(runtimeBytes, 'runtime env');
  const appEnv = stringField(backend, 'APP_ENV');
  if (!['development', 'test', 'staging', 'production'].includes(appEnv))
    throw new Error('APP_ENV is invalid');

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
    schemaVersion: 'auth-artifact-origin-evidence/v2',
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    frontendOrigin: browser.origin,
    apiOrigin: publicApi.origin,
    runtimeOrigin: runtimeOrigin.origin,
    appEnv,
    frontendInputSha256: createHash('sha256').update(frontendBytes).digest('hex'),
    backendInputSha256: createHash('sha256').update(backendBytes).digest('hex'),
    runtimeInputSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'origin preflight failed'}\n`);
  process.exitCode = 1;
});
