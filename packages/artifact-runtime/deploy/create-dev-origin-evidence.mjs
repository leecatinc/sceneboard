import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2,
  canonicalOriginV1,
} from '../dist/node/topology/index.js';

const [frontendPath, backendPath, runtimePath, outputPath] = process.argv
  .slice(2)
  .map((value) => resolve(value));
if ([frontendPath, backendPath, runtimePath, outputPath].some((value) => value === undefined))
  throw new TypeError('four absolute evidence paths are required');

const [frontendBytes, backendBytes, runtimeBytes] = await Promise.all([
  readFile(frontendPath),
  readFile(backendPath),
  readFile(runtimePath),
]);

const parseObject = (bytes, label) => {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError(`${label} is invalid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
};

const frontend = parseObject(frontendBytes, 'frontend input');
const backend = parseObject(backendBytes, 'backend input');
const runtime = parseObject(runtimeBytes, 'runtime input');
if (!['staging', 'production'].includes(backend.APP_ENV))
  throw new TypeError('hosted runtime evidence requires the staging or production environment');

const frontendOrigin = canonicalOriginV1(backend.BOARD_ALLOWED_ORIGINS, 'frontend origin').origin;
const apiOrigin = canonicalOriginV1(backend.BOARD_PUBLIC_API_ORIGIN, 'API origin').origin;
const runtimeOrigin = canonicalOriginV1(runtime.ARTIFACT_RUNTIME_ORIGIN, 'runtime origin').origin;
if (
  frontend.NEXT_PUBLIC_BOARD_API_URL !== apiOrigin ||
  frontend.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN !== runtimeOrigin ||
  runtime.ARTIFACT_RUNTIME_APP_ORIGIN !== frontendOrigin ||
  runtime.ARTIFACT_RUNTIME_API_ORIGIN !== apiOrigin
)
  throw new TypeError('development runtime topology inputs differ');

const generatedAt = new Date();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = {
  schemaVersion: ARTIFACT_ORIGIN_EVIDENCE_SCHEMA_V2,
  generatedAt: generatedAt.toISOString(),
  expiresAt: new Date(generatedAt.getTime() + 15 * 60 * 1_000).toISOString(),
  frontendOrigin,
  apiOrigin,
  runtimeOrigin,
  appEnv: backend.APP_ENV,
  frontendInputSha256: sha256(frontendBytes),
  backendInputSha256: sha256(backendBytes),
  runtimeInputSha256: sha256(runtimeBytes),
};

const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
try {
  await writeFile(temporaryPath, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, outputPath);
  await chmod(outputPath, 0o600);
} finally {
  await rm(temporaryPath, { force: true });
}
