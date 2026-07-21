import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ArtifactUsageReconciliation } from '../../src/artifacts/artifact-usage-reconciliation.js';

test('reconciles immutable artifact aggregates with bounded keyset reads and performs no repair', async () => {
  const sql: string[] = [];
  const responses = [
    [
      [
        {
          artifactCount: '1',
          versionCount: '1',
          resourceCount: '2',
          manifestCanonicalBytes: '100',
          resourceBytes: '30',
        },
      ],
      [],
    ],
    [[{ artifactPk: '10' }], []],
    [
      [{ versionPk: '20', manifestCanonicalBytes: 100, resourceCount: 2, resourceTotalBytes: 30 }],
      [],
    ],
    [
      [
        { resourcePk: '30', resourceBytes: 10 },
        { resourcePk: '31', resourceBytes: 20 },
      ],
      [],
    ],
  ];
  const connection = {
    execute: async (statement: string) => {
      sql.push(statement);
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected query');
      return next;
    },
  };
  const report = await new ArtifactUsageReconciliation().inspectBoard(
    connection as never,
    '1',
    500,
  );
  assert.equal(report.drift, false);
  assert.equal(report.aggregateColumnsMatchResources, true);
  assert.deepEqual(report.computed, {
    artifactCount: '1',
    versionCount: '1',
    resourceCount: '2',
    manifestCanonicalBytes: '100',
    resourceBytes: '30',
  });
  assert.equal(
    sql.every((statement) => !/\b(?:UPDATE|DELETE|INSERT)\b/iu.test(statement)),
    true,
  );
  assert.equal(
    sql.slice(1).every((statement) => /ORDER BY/iu.test(statement) && /LIMIT 500/u.test(statement)),
    true,
  );
});
