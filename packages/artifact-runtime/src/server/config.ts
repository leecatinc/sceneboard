import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertArtifactRuntimeTopologyV1,
  type ArtifactAppEnvironmentV1,
  type ArtifactRuntimeTopologyV1,
} from '../topology/index.js';

export type ArtifactRuntimeConfigV1 = ArtifactRuntimeTopologyV1 & {
  publicDirectory: string;
};

const string = (environment: NodeJS.ProcessEnv, key: string): string => {
  const value = environment[key];
  if (value === undefined || value.length === 0 || value !== value.trim())
    throw new TypeError(`${key} is required`);
  return value;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const loadArtifactRuntimeConfigV1 = async (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ArtifactRuntimeConfigV1> => {
  const appEnv = string(environment, 'APP_ENV');
  if (!['development', 'test', 'staging', 'production'].includes(appEnv))
    throw new TypeError('APP_ENV is invalid');
  const evidencePath = resolve(string(environment, 'ARTIFACT_RUNTIME_EVIDENCE_FILE'));
  const frontendInputPath = resolve(
    string(environment, 'ARTIFACT_RUNTIME_FRONTEND_RESOLVED_INPUT_FILE'),
  );
  const backendInputPath = resolve(
    string(environment, 'ARTIFACT_RUNTIME_BACKEND_RESOLVED_INPUT_FILE'),
  );
  const runtimeInputPath = resolve(string(environment, 'ARTIFACT_RUNTIME_RESOLVED_INPUT_FILE'));
  const [evidenceBytes, frontendInputBytes, backendInputBytes, runtimeInputBytes] =
    await Promise.all([
      readFile(evidencePath),
      readFile(frontendInputPath),
      readFile(backendInputPath),
      readFile(runtimeInputPath),
    ]);
  let evidence: unknown;
  try {
    evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidenceBytes));
  } catch {
    throw new TypeError('runtime origin evidence is invalid JSON');
  }
  const topology = assertArtifactRuntimeTopologyV1({
    appEnv: appEnv as ArtifactAppEnvironmentV1,
    frontendOrigin: string(environment, 'ARTIFACT_RUNTIME_APP_ORIGIN'),
    apiOrigin: string(environment, 'ARTIFACT_RUNTIME_API_ORIGIN'),
    runtimeOrigin: string(environment, 'ARTIFACT_RUNTIME_ORIGIN'),
    listenHost: string(environment, 'ARTIFACT_RUNTIME_LISTEN_HOST'),
    listenPort: Number(string(environment, 'PORT')),
    evidence,
    expectedInputSha256: {
      frontend: sha256(frontendInputBytes),
      backend: sha256(backendInputBytes),
      runtime: sha256(runtimeInputBytes),
    },
  });
  return {
    ...topology,
    publicDirectory: resolve(string(environment, 'ARTIFACT_RUNTIME_PUBLIC_DIR')),
  };
};
