import { cpus } from 'node:os';

import bcrypt from 'bcryptjs';

import { calibrateBcrypt, type BcryptCapacityBudget } from '../src/auth/bcrypt-calibration.js';

const parseBudget = (encoded: string | undefined): BcryptCapacityBudget | null => {
  if (encoded === undefined) return null;
  const value = JSON.parse(encoded) as Partial<BcryptCapacityBudget>;
  const keys = [
    'maxConcurrency',
    'minHashThroughputPerSecond',
    'minCompareThroughputPerSecond',
    'maxEventLoopDelayP95Ms',
    'maxRssDeltaBytes',
    'maxBatchDurationMs',
  ] as const;
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError('BCRYPT_AUTH_CAPACITY_BUDGET_JSON has unknown or missing keys');
  }
  return value as BcryptCapacityBudget;
};

const cpuClass = process.env.CALIBRATION_CPU_CLASS;
const deploymentClassConfirmed =
  process.env.CONFIRM_DEPLOYMENT_CLASS_CPU === 'I_CONFIRM_THIS_IS_THE_DEPLOYMENT_CPU';
if (
  cpuClass !== undefined &&
  (!/^[-A-Za-z0-9_. ]{1,100}$/.test(cpuClass) || cpuClass.trim() !== cpuClass)
) {
  throw new TypeError('CALIBRATION_CPU_CLASS must be a safe 1-100 character label');
}

const report = await calibrateBcrypt(
  {
    hash: (password, cost) => bcrypt.hash(password, cost),
    compare: (password, hash) => bcrypt.compare(password, hash),
  },
  { capacityBudget: parseBudget(process.env.BCRYPT_AUTH_CAPACITY_BUDGET_JSON) },
);

const accepted = deploymentClassConfirmed && cpuClass !== undefined && report.selectedCost !== null;
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    cpu: {
      class: cpuClass ?? null,
      model: cpus()[0]?.model ?? 'unknown',
      logicalCount: cpus().length,
    },
    deploymentClassConfirmed,
    accepted,
    report,
  })}\n`,
);
if (!accepted) process.exitCode = 2;
