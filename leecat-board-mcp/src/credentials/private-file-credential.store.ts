import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseCredentialRecordV1,
  sameCredentialV1,
  type CredentialRecordV1,
} from './credential-record.js';

const CREDENTIAL_FILE = 'credential.json';

export const assertPrivateStateDirectoryV1 = async (stateDirectory: string): Promise<void> => {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const status = await lstat(stateDirectory);
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.geteuid?.()) {
    throw new Error('private state directory is invalid');
  }
  if ((status.mode & 0o777) !== 0o700) {
    const handle = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  const confirmed = await lstat(stateDirectory);
  if ((confirmed.mode & 0o777) !== 0o700) throw new Error('private state directory permissions are invalid');
};

const assertPrivateFile = async (path: string): Promise<void> => {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.geteuid?.()
    || (status.mode & 0o777) !== 0o600 || status.nlink !== 1) throw new Error('private record is invalid');
};

export const atomicPrivateWriteV1 = async (
  stateDirectory: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> => {
  await assertPrivateStateDirectoryV1(stateDirectory);
  const temporaryName = `.${fileName}.${randomBytes(16).toString('base64url')}.tmp`;
  const temporaryPath = join(stateDirectory, temporaryName);
  const targetPath = join(stateDirectory, fileName);
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await assertPrivateFile(temporaryPath);
  await rename(temporaryPath, targetPath);
  const directory = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export class PrivateFileCredentialStoreV1 {
  constructor(readonly stateDirectory: string) {}

  async preflight(): Promise<void> {
    await assertPrivateStateDirectoryV1(this.stateDirectory);
  }

  async read(): Promise<CredentialRecordV1 | null> {
    const path = join(this.stateDirectory, CREDENTIAL_FILE);
    try {
      await assertPrivateFile(path);
      return parseCredentialRecordV1(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async replace(accessToken: string): Promise<CredentialRecordV1> {
    const record = parseCredentialRecordV1(new TextEncoder().encode(JSON.stringify({
      version: 1,
      generation: randomBytes(16).toString('base64url'),
      accessToken,
    })));
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    try {
      await atomicPrivateWriteV1(this.stateDirectory, CREDENTIAL_FILE, bytes);
    } finally {
      bytes.fill(0);
    }
    return record;
  }

  async deleteIfCurrent(snapshot: CredentialRecordV1): Promise<boolean> {
    const current = await this.read();
    if (current === null || !sameCredentialV1(current, snapshot)) return false;
    await unlink(join(this.stateDirectory, CREDENTIAL_FILE));
    const directory = await open(this.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  }
}
