import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CertificationEvidenceWriter } from '../../scripts/lib/certification/evidence-writer.mjs';
import { assertSafeCommand } from '../../scripts/lib/certification/safe-command-policy.mjs';

const tempRoot = join(tmpdir(), `sceneboard-evidence-writer-${process.pid}`);
const hash = 'a'.repeat(64);

test('evidence writer is append-only, token-bound, bounded, and non-self-referential', async (context) => {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  context.after(() => rm(tempRoot, { recursive: true, force: true }));
  const writer = await CertificationEvidenceWriter.create({
    workspaceRoot: tempRoot,
    sourceCommit: 'b'.repeat(40),
    manifestSha256: 'c'.repeat(64),
    profile: 'test',
    attemptId: 'attempt-001',
  });
  const record = {
    schemaVersion: 1,
    rowId: 'STATIC-001',
    phase: 'static',
    owner: 'D9',
    status: 'PASS',
    safeCode: 'CONTRACTS_VERIFIED',
    inputSha256: hash,
    resultSha256: hash,
    cleanupStatus: 'PASS',
  };
  await writer.writeRecord(writer.ownerToken, record);
  await assert.rejects(
    () => writer.writeRecord(writer.ownerToken, record),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  await assert.rejects(
    () => writer.writeRecord('wrong-token', { ...record, rowId: 'STATIC-002' }),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  const attachment = await writer.writeAttachment(
    writer.ownerToken,
    Buffer.from('safe static summary'),
    'text/plain',
  );
  assert.equal(attachment.byteLength, 19);
  await writer.finalizePhase(writer.ownerToken, 'static', {
    schemaVersion: 1,
    phase: 'static',
    status: 'PASS',
    recordIds: ['STATIC-001'],
  });
  const exclusion = await writer.writeRunExclusion(writer.ownerToken, {
    schemaVersion: 1,
    status: 'excluded-by-user-current-run',
    decisionId: 'AMD-06',
    campaignIds: ['database-capacity', 'multi-client-capacity', 'redis-loss-capacity'],
    provenance: 'user-decision',
    decisionProvenanceSha256: hash,
    runId: 'test-run',
    timestamp: '2026-07-28T07:00:00.000Z',
    reason: 'heavyweight campaigns excluded by the user for this run',
    attemptId: 'attempt-001',
  });
  await assert.rejects(
    () =>
      writer.writeRunExclusion(writer.ownerToken, {
        schemaVersion: 1,
        status: 'excluded-by-user-current-run',
        decisionId: 'AMD-06',
        attemptId: 'attempt-001',
      }),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  await assert.rejects(
    () =>
      writer.writeRunExclusion('wrong-token', {
        schemaVersion: 1,
        status: 'excluded-by-user-current-run',
        decisionId: 'AMD-06',
        attemptId: 'attempt-001',
      }),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
  await assert.rejects(
    () =>
      writer.finalizeRelease(writer.ownerToken, {
        schemaVersion: 1,
        status: 'PASS',
      }),
    (error) => error?.code === 'EVIDENCE_EXCLUSION_HASH_MISSING',
  );
  const released = await writer.finalizeRelease(writer.ownerToken, {
    schemaVersion: 1,
    attemptEnvelope: {
      certificationSourceCommit: 'b'.repeat(40),
      manifestSha256: 'c'.repeat(64),
      observedInputHashes: { contract: hash },
      profile: 'test',
      attemptId: 'attempt-001',
      laneId: 'correctness',
    },
    status: 'PASS',
    phases: ['static'],
    cleanupStatus: 'PASS',
    presentationManifestSha256: hash,
    runExclusion: {
      decisionId: 'AMD-06',
      status: 'excluded-by-user-current-run',
      path: exclusion.path,
      recordSha256: exclusion.recordSha256,
      attemptId: 'attempt-001',
    },
  });
  assert.match(released.evidenceTreeSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(
    () => writer.finalizeRelease(writer.ownerToken, {}),
    (error) => error?.code === 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
  );
});

test('safe command policy rejects npx, shell syntax, production targets, and destructive commands', () => {
  const root = '/workspace/lc/leecat-board';
  assert.deepEqual(
    assertSafeCommand({ command: 'npm', args: ['run', 'verify:contracts'], workspaceRoot: root }),
    {
      command: 'npm',
      args: ['run', 'verify:contracts'],
    },
  );
  for (const input of [
    { command: 'npx', args: ['playwright'] },
    { command: 'npm', args: ['run', 'test;rm'] },
    { command: 'git', args: ['reset', '--hard'] },
    { command: 'npm', args: ['run', 'deploy', '--', '--profile=production'] },
  ]) {
    assert.throws(
      () => assertSafeCommand({ ...input, workspaceRoot: root }),
      (error) => error?.code === 'FORBIDDEN_CERTIFICATION_COMMAND',
    );
  }
});
