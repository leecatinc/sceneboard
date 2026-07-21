import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import {
  PERSISTENCE_PROBE_ORDER_V1,
  type CertificationCallerV1,
  type CertificationModeV1,
  type PersistenceCertificationFailureCategoryV1,
  type PersistenceProbeIdV1,
} from './persistence-certification.types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type PersistenceProbeProgressV1 = Readonly<{
  lastVerifiedCursor: string | null;
  batchCount: number;
  scannedRows: number;
  scannedBytes: number;
  complete: boolean;
}>;

export type PersistenceCertificationProgressV1 = Readonly<{
  formatVersion: 1;
  mode: Extract<CertificationModeV1, 'FULL_OFFLINE' | 'RESUMABLE_AUDIT'>;
  caller: Extract<
    CertificationCallerV1,
    'db:migrate:up' | 'db:migrate:adopt' | 'quarantine.restore.promote' | 'db:persistence:scan'
  >;
  registryVersion: string;
  schemaFingerprintSha256: string;
  databaseIdentitySha256: string;
  capturedHighWaterMarks: Readonly<Record<PersistenceProbeIdV1, string>>;
  probes: Readonly<Record<PersistenceProbeIdV1, PersistenceProbeProgressV1>>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  deferredRows: number;
  failureCategory: PersistenceCertificationFailureCategoryV1 | null;
}>;

export type PersistenceCertificationResumeIdentityV1 = Readonly<{
  mode: PersistenceCertificationProgressV1['mode'];
  caller: PersistenceCertificationProgressV1['caller'];
  registryVersion: string;
  schemaFingerprintSha256: string;
  databaseIdentitySha256: string;
  capturedHighWaterMarks: PersistenceCertificationProgressV1['capturedHighWaterMarks'];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validateTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  UTC_MILLISECOND_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(value));

const validateProbeProgress = (value: unknown): value is PersistenceProbeProgressV1 => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'lastVerifiedCursor',
      'batchCount',
      'scannedRows',
      'scannedBytes',
      'complete',
    ])
  )
    return false;
  return (
    (value.lastVerifiedCursor === null || typeof value.lastVerifiedCursor === 'string') &&
    isSafeCount(value.batchCount) &&
    isSafeCount(value.scannedRows) &&
    isSafeCount(value.scannedBytes) &&
    typeof value.complete === 'boolean'
  );
};

export const validatePersistenceCertificationProgressV1 = (
  value: unknown,
): PersistenceCertificationProgressV1 => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'formatVersion',
      'mode',
      'caller',
      'registryVersion',
      'schemaFingerprintSha256',
      'databaseIdentitySha256',
      'capturedHighWaterMarks',
      'probes',
      'startedAt',
      'updatedAt',
      'completedAt',
      'deferredRows',
      'failureCategory',
    ])
  )
    throw new TypeError('persistence certification progress has an invalid shape');

  const allowedCallers = [
    'db:migrate:up',
    'db:migrate:adopt',
    'quarantine.restore.promote',
    'db:persistence:scan',
  ];
  if (
    value.formatVersion !== 1 ||
    (value.mode !== 'FULL_OFFLINE' && value.mode !== 'RESUMABLE_AUDIT') ||
    typeof value.caller !== 'string' ||
    !allowedCallers.includes(value.caller) ||
    typeof value.registryVersion !== 'string' ||
    value.registryVersion.length === 0 ||
    typeof value.schemaFingerprintSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.schemaFingerprintSha256) ||
    typeof value.databaseIdentitySha256 !== 'string' ||
    !SHA256_PATTERN.test(value.databaseIdentitySha256) ||
    !validateTimestamp(value.startedAt) ||
    !validateTimestamp(value.updatedAt) ||
    (value.completedAt !== null && !validateTimestamp(value.completedAt)) ||
    !isSafeCount(value.deferredRows) ||
    (value.failureCategory !== null &&
      ![
        'CONNECTION',
        'STATE_OR_PROFILE',
        'SCHEMA_METADATA',
        'DEADLINE',
        'ROW_MAPPING',
        'PROBE',
        'CURSOR',
        'HIGH_WATER_CHANGED',
        'ORDERING',
        'INTERRUPTED',
        'INCONCLUSIVE_CONCURRENT_CHANGE',
      ].includes(String(value.failureCategory)))
  ) {
    throw new TypeError('persistence certification progress contains an invalid value');
  }

  const capturedHighWaterMarks = value.capturedHighWaterMarks;
  if (
    !isRecord(capturedHighWaterMarks) ||
    !hasExactKeys(capturedHighWaterMarks, PERSISTENCE_PROBE_ORDER_V1) ||
    PERSISTENCE_PROBE_ORDER_V1.some(
      (probeId) => typeof capturedHighWaterMarks[probeId] !== 'string',
    )
  ) {
    throw new TypeError('persistence certification progress has invalid high-water marks');
  }
  const probes = value.probes;
  if (
    !isRecord(probes) ||
    !hasExactKeys(probes, PERSISTENCE_PROBE_ORDER_V1) ||
    PERSISTENCE_PROBE_ORDER_V1.some((probeId) => !validateProbeProgress(probes[probeId]))
  ) {
    throw new TypeError('persistence certification progress has invalid probe state');
  }
  if (
    Date.parse(value.updatedAt) < Date.parse(value.startedAt) ||
    (value.completedAt !== null && Date.parse(value.completedAt) < Date.parse(value.updatedAt))
  ) {
    throw new TypeError('persistence certification progress timestamps are not monotonic');
  }
  return value as PersistenceCertificationProgressV1;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const canonicalJson = (value: unknown): string => `${JSON.stringify(canonicalize(value))}\n`;

const assertResumeIdentity = (
  progress: PersistenceCertificationProgressV1,
  identity: PersistenceCertificationResumeIdentityV1,
): void => {
  const highWaterMatches = PERSISTENCE_PROBE_ORDER_V1.every(
    (probeId) =>
      progress.capturedHighWaterMarks[probeId] === identity.capturedHighWaterMarks[probeId],
  );
  if (
    progress.mode !== identity.mode ||
    progress.caller !== identity.caller ||
    progress.registryVersion !== identity.registryVersion ||
    progress.schemaFingerprintSha256 !== identity.schemaFingerprintSha256 ||
    progress.databaseIdentitySha256 !== identity.databaseIdentitySha256 ||
    !highWaterMatches
  ) {
    throw new TypeError(
      'persistence certification progress identity does not match the requested resume',
    );
  }
};

export class PersistenceCertificationProgressStore {
  constructor(readonly path: string) {
    if (!isAbsolute(path))
      throw new TypeError('persistence certification progress path must be absolute');
  }

  async readForResume(
    identity: PersistenceCertificationResumeIdentityV1,
  ): Promise<PersistenceCertificationProgressV1> {
    await this.assertTargetIsNotSymlink();
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new TypeError('persistence certification progress must be a mode-0600 regular file');
      }
      const source = await handle.readFile({ encoding: 'utf8' });
      const progress = validatePersistenceCertificationProgressV1(JSON.parse(source) as unknown);
      assertResumeIdentity(progress, identity);
      return progress;
    } finally {
      await handle.close();
    }
  }

  async write(progress: PersistenceCertificationProgressV1): Promise<void> {
    const validated = validatePersistenceCertificationProgressV1(progress);
    await this.assertTargetIsNotSymlink();
    const parent = dirname(this.path);
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(canonicalJson(validated), { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.path);
      const target = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await target.sync();
        // Some shared-workspace filesystems restore inherited ACL masks during fsync.
        // Apply the final fail-closed mode after the content sync and before publication completes.
        await target.chmod(0o600);
      } finally {
        await target.close();
      }
      const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      // The collaborative workspace reapplies its default ACL when the last file
      // descriptor closes. Reassert and verify the required effective mode last.
      await this.assertTargetIsNotSymlink();
      await chmod(this.path, 0o600);
      const published = await lstat(this.path);
      if (!published.isFile() || published.isSymbolicLink() || (published.mode & 0o777) !== 0o600) {
        throw new TypeError('persistence certification progress publication is not mode 0600');
      }
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async assertTargetIsNotSymlink(): Promise<void> {
    const stat = await lstat(this.path).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new TypeError('persistence certification progress path must not be a symbolic link');
  }
}
