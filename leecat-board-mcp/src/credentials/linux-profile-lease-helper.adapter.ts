import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import {
  ProfileLeaseErrorV1,
  type ProfileLeaseAdapterV1,
  type ProfileStateLeaseV1,
} from './profile-state.lease.js';

const FRAME_LIMIT = 64;

type LeaseHelperProcess = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

const waitForFrame = async (child: LeaseHelperProcess): Promise<string> => new Promise((resolve, reject) => {
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => reject(new ProfileLeaseErrorV1('liveness_unknown')), 2_000);
  timer.unref();
  const cleanup = (): void => {
    clearTimeout(timer);
    child.stdout.off('data', onData);
    child.stdout.off('end', onEnd);
    child.off('error', onError);
  };
  const onError = (): void => {
    cleanup();
    reject(new ProfileLeaseErrorV1('liveness_unknown'));
  };
  const onEnd = (): void => {
    cleanup();
    reject(new ProfileLeaseErrorV1('liveness_unknown'));
  };
  const onData = (chunk: Buffer): void => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.byteLength > FRAME_LIMIT) {
      cleanup();
      reject(new ProfileLeaseErrorV1('lease_corrupt'));
      return;
    }
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return;
    cleanup();
    resolve(bytes.subarray(0, newline).toString('ascii'));
  };
  child.stdout.on('data', onData);
  child.stdout.once('end', onEnd);
  child.once('error', onError);
});

export class LinuxProfileLeaseHelperAdapterV1 implements ProfileLeaseAdapterV1 {
  constructor(
    private readonly helperPath: string,
    private readonly digestPath: string,
  ) {}

  async verify(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      const [status, digestStatus, bytes, expected] = await Promise.all([
        lstat(this.helperPath),
        lstat(this.digestPath),
        readFile(this.helperPath),
        readFile(this.digestPath, 'utf8'),
      ]);
      if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o500
        || status.uid !== process.geteuid?.()) return false;
      if (!digestStatus.isFile() || digestStatus.isSymbolicLink()
        || digestStatus.uid !== process.geteuid?.()) return false;
      return createHash('sha256').update(bytes).digest('hex') === expected.trim();
    } catch {
      return false;
    }
  }

  async acquire(stateDirectory: string): Promise<ProfileStateLeaseV1> {
    if (!await this.verify()) throw new ProfileLeaseErrorV1('liveness_unknown');
    const directory = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let spawned: ChildProcess;
    try {
      spawned = spawn(this.helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', directory.fd],
        env: {},
      });
    } catch {
      await directory.close();
      throw new ProfileLeaseErrorV1('liveness_unknown');
    }
    await directory.close();
    if (spawned.stdin === null || spawned.stdout === null || spawned.stderr === null) {
      spawned.kill('SIGTERM');
      throw new ProfileLeaseErrorV1('liveness_unknown');
    }
    const child = spawned as LeaseHelperProcess;
    child.stderr.resume();
    const record = JSON.stringify({
      version: 1,
      state: 'live',
      nonce: randomBytes(16).toString('base64url'),
      pid: process.pid,
    });
    child.stdin.write(`${record}\n`);
    let frame: string;
    try {
      frame = await waitForFrame(child);
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
    if (frame === 'busy') {
      child.stdin.end();
      throw new ProfileLeaseErrorV1('active_owner');
    }
    if (frame === 'corrupt') {
      child.stdin.end();
      throw new ProfileLeaseErrorV1('lease_corrupt');
    }
    if (frame !== 'ready') {
      child.stdin.end();
      throw new ProfileLeaseErrorV1('liveness_unknown');
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        child.stdin.end();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            resolve();
          }, 2_000);
          timer.unref();
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }
}
