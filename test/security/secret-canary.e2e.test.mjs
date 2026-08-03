import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateHttpErrorSinkCaptureV1 } from '../../scripts/lib/certification/security-boundary-producers.mjs';
import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const assertRejectedBeforeEvidence = async (capture) => {
  const receiptDirectory = await mkdtemp(join(tmpdir(), 'sceneboard-error-capture-rejected-'));
  try {
    assert.throws(() => validateHttpErrorSinkCaptureV1(capture));
    assert.deepEqual(await readdir(receiptDirectory), []);
  } finally {
    await rm(receiptDirectory, { recursive: true, force: true });
  }
};

const responseOnlyBytes = [Buffer.from('{"error":{"code":"INTERNAL_ERROR"}}')];
const validErrorRecord = JSON.stringify({
  name: 'SafeOperationalError',
  message: 'Operation failed',
  details: {},
});
for (const rejectedCapture of [
  { sink: 'ERROR', canary: 'raw-canary', errorRecords: [], responseBytes: [] },
  {
    sink: 'ERROR',
    canary: 'raw-canary',
    errorRecords: [],
    responseBytes: responseOnlyBytes,
  },
  {
    sink: 'ERROR',
    canary: 'raw-canary',
    errorRecords: [validErrorRecord, validErrorRecord],
    responseBytes: [],
  },
  {
    sink: 'ERROR',
    canary: 'raw-canary',
    errorRecords: ['{"error":{"code":"INTERNAL_ERROR"}}'],
    responseBytes: [],
  },
  {
    sink: 'ERROR',
    canary: 'raw-canary',
    errorRecords: [
      JSON.stringify({
        name: 'SafeOperationalError',
        message: 'Operation failed',
        details: { diagnostic: 'raw-canary' },
      }),
    ],
    responseBytes: [],
  },
])
  await assertRejectedBeforeEvidence(rejectedCapture);

const executeSecretBoundary = (row) => {
  if (
    !Array.isArray(row.transportOnlyCanaryAllowance) ||
    row.transportOnlyCanaryAllowance.length !== 1 ||
    row.transportOnlyCanaryAllowance.some(
      (allowance) => typeof allowance !== 'string' || allowance.length === 0,
    )
  )
    throw new Error(`unexpected transport-only canary allowance for ${row.caseId}`);
  return Object.freeze({
    transportOnlyCanaryAllowance: Object.freeze([...row.transportOnlyCanaryAllowance]),
  });
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.secret-canary.v1',
  expectedCounts: { SECRET_CANARY: 156 },
  adapter: executeSecretBoundary,
});
