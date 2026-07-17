import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  calibratePairingClaims,
  type PairingClaimCalibrationHarness,
  type PairingClaimCapacityBudget,
} from '../src/pairing/pairing-claim-calibration.js';

interface HarnessOwner {
  harness: PairingClaimCalibrationHarness;
  close(): Promise<void>;
}

interface HarnessModule {
  createPairingClaimCalibrationHarness(): Promise<HarnessOwner>;
}

const strictInteger = (name: string, minimum: number, maximum: number): number => {
  const raw = process.env[name];
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) throw new TypeError(`${name} must be a canonical decimal integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is outside its allowed range`);
  return value;
};

if (process.env.CONFIRM_ISOLATED_PAIRING_CALIBRATION !== 'I_CONFIRM_THIS_IS_AN_ISOLATED_DISPOSABLE_SCHEMA') {
  throw new TypeError('pairing calibration requires explicit isolated disposable schema confirmation');
}
const modulePath = process.env.PAIRING_CALIBRATION_HARNESS_MODULE;
if (modulePath === undefined || modulePath.length === 0) throw new TypeError('PAIRING_CALIBRATION_HARNESS_MODULE is required');
const budgetEncoded = process.env.PAIRING_CLAIM_CAPACITY_BUDGET_JSON;
if (budgetEncoded === undefined) throw new TypeError('PAIRING_CLAIM_CAPACITY_BUDGET_JSON is required');
const budget = JSON.parse(budgetEncoded) as PairingClaimCapacityBudget;
const imported = await import(pathToFileURL(resolve(modulePath)).href) as Partial<HarnessModule>;
if (typeof imported.createPairingClaimCalibrationHarness !== 'function') {
  throw new TypeError('pairing calibration harness module has no createPairingClaimCalibrationHarness export');
}
const owner = await imported.createPairingClaimCalibrationHarness();
try {
  const report = await calibratePairingClaims(owner.harness, {
    configuredFailureMinimumMs: strictInteger('PAIRING_FAILURE_MIN_MS', 50, 2_000),
    configuredFailureJitterMs: strictInteger('PAIRING_FAILURE_JITTER_MS', 10, 25),
    capacityBudget: budget,
  });
  process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), report })}\n`);
  if (!report.accepted) process.exitCode = 2;
} finally {
  await owner.close();
}
