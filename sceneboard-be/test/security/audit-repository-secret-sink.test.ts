import assert from 'node:assert/strict';
import test from 'node:test';

import { observeMandatoryAuditWriteV1 } from '../../src/audit/audit.repository.js';

const baseInput = {
  event: 'export.started' as const,
  userPublicId: null,
  sessionPublicId: null,
  subjectFingerprint: null,
};

test('mandatory audit certification observes the real persistence boundary', async () => {
  const writes: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  await observeMandatoryAuditWriteV1({
    input: {
      ...baseInput,
      metadata: { correlationId: 'certification', format: 'pdf', revisionNumber: 1 },
    },
    observe: (sql, parameters) => writes.push({ sql, parameters }),
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]?.sql ?? '', /INSERT INTO security_audit_events/u);
  assert.equal(JSON.stringify(writes).includes('certification'), true);
});

test('mandatory audit rejects raw canaries before persistence and exposes only a fixed rejection', async () => {
  const canary = `sk-${'A'.repeat(43)}`;
  const writes: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  await assert.rejects(
    () =>
      observeMandatoryAuditWriteV1({
        input: { ...baseInput, metadata: { payload: canary } },
        observe: (sql, parameters) => writes.push({ sql, parameters }),
      }),
    /audit metadata key is not allowed/u,
  );
  assert.deepEqual(writes, [{ sql: 'AUDIT_SECRET_FIELD_REJECTED', parameters: [] }]);
  assert.equal(JSON.stringify(writes).includes(canary), false);
});
