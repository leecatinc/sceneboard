import { createHash } from 'node:crypto';

export type MigrationConnectionProfileV1 = Readonly<{
  databaseIdentitySha256: string;
  serverVersion: string;
  timeZone: '+00:00';
  characterSet: 'utf8mb4';
  collation: 'utf8mb4_0900_ai_ci';
  sqlModeSha256: string;
}>;

export type MigrationCertificationStateV1 = Readonly<{
  mode: 'fresh' | 'adopt' | 'restart';
  registryVersion: string;
  connectionProfile: MigrationConnectionProfileV1;
}>;

export interface MigrationConnectionProfileInput {
  databaseIdentity: string;
  serverVersion: string;
  timeZone: string;
  characterSet: string;
  collation: string;
  sqlMode: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const buildMigrationConnectionProfile = (
  input: MigrationConnectionProfileInput,
): MigrationConnectionProfileV1 => {
  if (input.timeZone !== '+00:00') throw new TypeError('migration connection time zone must be +00:00');
  if (input.characterSet !== 'utf8mb4') throw new TypeError('migration connection character set must be utf8mb4');
  if (input.collation !== 'utf8mb4_0900_ai_ci') throw new TypeError('migration connection collation is invalid');
  if (!/^8\.0\.(?:1[6-9]|[2-9][0-9])(?:[-+].*)?$/.test(input.serverVersion)) {
    throw new TypeError('MySQL Community version must be >=8.0.16 and <8.1.0');
  }
  const modes = input.sqlMode.split(',').filter(Boolean).sort();
  const required = ['ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION', 'STRICT_TRANS_TABLES'];
  if (required.some((mode) => !modes.includes(mode)) || modes.includes('NO_BACKSLASH_ESCAPES')) {
    throw new TypeError('migration connection SQL mode is incompatible');
  }
  return {
    databaseIdentitySha256: sha256(input.databaseIdentity),
    serverVersion: input.serverVersion,
    timeZone: '+00:00',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    sqlModeSha256: sha256(modes.join(',')),
  };
};
