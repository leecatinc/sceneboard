import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicPrivateWriteV1 } from './private-file-credential.store.js';

const FILE_NAME = 'installation.json';
const INSTALLATION_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

const parseInstallation = (bytes: Uint8Array): string => {
  if (bytes.byteLength === 0 || bytes.byteLength > 256) throw new Error('installation record is invalid');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('installation record is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('installation record is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('installation record is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== ['installationId', 'version'].join('\0')
    || record.version !== 1 || typeof record.installationId !== 'string'
    || !INSTALLATION_PATTERN.test(record.installationId) || JSON.stringify(record) !== source) {
    throw new Error('installation record is invalid');
  }
  return record.installationId;
};

export class InstallationIdentityStoreV1 {
  constructor(private readonly stateDirectory: string) {}

  async getOrCreate(): Promise<string> {
    const path = join(this.stateDirectory, FILE_NAME);
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.geteuid?.()
        || (status.mode & 0o777) !== 0o600 || status.nlink !== 1) throw new Error('installation record is invalid');
      return parseInstallation(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const installationId = `install_${randomBytes(24).toString('base64url')}`;
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, installationId }));
    await atomicPrivateWriteV1(this.stateDirectory, FILE_NAME, bytes);
    return installationId;
  }
}
