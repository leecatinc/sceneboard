import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { RevisionPayloadCutoverService } from '../../src/revisions/revision-payload-cutover.service.js';

const row = (revisionPk: string, storedBytes: number) => ({
  revisionPk,
  schemaVersion: '2.0.0',
  codec: 'B',
  payload: Buffer.alloc(storedBytes),
  canonicalBytes: storedBytes,
  storedBytes,
  sha256: Buffer.alloc(32, Number(revisionPk)),
});

type InlineFixture = ReturnType<typeof row>;
type DetachedFixture = Omit<InlineFixture, 'schemaVersion' | 'codec'> & {
  schemaVersion: string;
  codec: string;
  state: 'available' | 'reclaiming';
};

const tupleMatches = (inline: InlineFixture, detached: DetachedFixture): boolean =>
  inline.schemaVersion === detached.schemaVersion &&
  inline.codec === detached.codec &&
  inline.canonicalBytes === detached.canonicalBytes &&
  inline.storedBytes === detached.storedBytes &&
  inline.sha256.equals(detached.sha256) &&
  inline.payload.equals(detached.payload);

const statefulConnection = (
  inlineRows: readonly InlineFixture[],
  initialDetached: DetachedFixture | null,
) => {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  let detached = initialDetached;
  const connection = {
    async execute(sql: string, binds: unknown[] = []) {
      calls.push({ sql, binds });
      if (sql.includes('SELECT CAST(revision_pk AS CHAR)')) return [inlineRows, []];
      if (sql.includes('FROM board_revision_payloads')) {
        return [detached === null ? [] : [detached], []];
      }
      if (sql.includes('INSERT INTO board_revision_payloads')) {
        assert.equal(detached, null, 'an existing detached tuple must never be inserted over');
        detached = {
          revisionPk: String(binds[0]),
          schemaVersion: String(binds[1]),
          codec: String(binds[2]),
          canonicalBytes: Number(binds[3]),
          storedBytes: Number(binds[4]),
          sha256: Buffer.from(binds[5] as Uint8Array),
          payload: Buffer.from(binds[6] as Uint8Array),
          state: 'available',
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('UPDATE board_revision_payloads')) {
        assert.ok(detached);
        assert.equal(detached.state, 'reclaiming');
        detached = { ...detached, state: 'available' };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('COALESCE(SUM')) {
        const inline = inlineRows[0];
        const exact = inline !== undefined && detached !== null && tupleMatches(inline, detached);
        return [
          [
            {
              missingDetached: detached === null ? '1' : '0',
              parityMismatch: exact && detached?.state === 'available' ? '0' : '1',
            },
          ],
          [],
        ];
      }
      if (sql.includes('UPDATE board_revisions r')) {
        const inline = inlineRows[0];
        const exact = inline !== undefined && detached !== null && tupleMatches(inline, detached);
        return [{ affectedRows: exact && detached?.state === 'available' ? 1 : 0 }, []];
      }
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolConnection;
  return { connection, calls, detached: () => detached };
};

const assertCategory = async (
  operation: Promise<unknown>,
  category: BoardPersistenceError['category'],
): Promise<void> => {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof BoardPersistenceError && error.category === category,
  );
};

test('backfill inserts an absent tuple, preserves the resume cursor, and accepts an empty batch', async () => {
  const first = row('1', 33_554_432);
  const state = statefulConnection([first, row('2', 1)], null);
  assert.deepEqual(await new RevisionPayloadCutoverService().backfillBatch(state.connection, '0'), {
    processed: 1,
    storedBytes: 33_554_432,
    nextRevisionPk: '1',
  });
  assert.deepEqual(state.detached(), { ...first, state: 'available' });
  assert.match(state.calls[0]?.sql ?? '', /ORDER BY revision_pk ASC\s+LIMIT 101\s+FOR UPDATE/u);
  assert.deepEqual(state.calls[0]?.binds, ['0']);
  assert.match(state.calls[1]?.sql ?? '', /FROM board_revision_payloads/u);
  assert.match(state.calls[1]?.sql ?? '', /FOR UPDATE/u);
  assert.match(state.calls[2]?.sql ?? '', /INSERT INTO board_revision_payloads/u);

  const empty = statefulConnection([], null);
  assert.deepEqual(await new RevisionPayloadCutoverService().backfillBatch(empty.connection, '9'), {
    processed: 0,
    storedBytes: 0,
    nextRevisionPk: null,
  });
  assert.equal(empty.calls.length, 1);
});

test('backfill is a no-op for an exact available tuple and only changes reclaiming state', async () => {
  const inline = row('1', 8);
  const exactCopy = {
    ...inline,
    sha256: Buffer.from(inline.sha256),
    payload: Buffer.from(inline.payload),
  };
  const available = statefulConnection([inline], { ...exactCopy, state: 'available' });
  assert.deepEqual(
    await new RevisionPayloadCutoverService().backfillBatch(available.connection, '0'),
    { processed: 1, storedBytes: 8, nextRevisionPk: '1' },
  );
  assert.deepEqual(available.detached(), { ...inline, state: 'available' });
  assert.equal(available.calls.length, 2);

  const reclaiming = statefulConnection([inline], { ...exactCopy, state: 'reclaiming' });
  assert.deepEqual(
    await new RevisionPayloadCutoverService().backfillBatch(reclaiming.connection, '0'),
    { processed: 1, storedBytes: 8, nextRevisionPk: '1' },
  );
  assert.deepEqual(reclaiming.detached(), { ...inline, state: 'available' });
  const update = reclaiming.calls[2]?.sql ?? '';
  assert.match(update, /UPDATE board_revision_payloads\s+SET state = 'available'/u);
  assert.doesNotMatch(
    update,
    /SET[^]*schema_version|SET[^]*codec|SET[^]*canonical_bytes|SET[^]*stored_bytes|SET[^]*payload_sha256|SET[^]*payload/u,
  );
});

test('backfill rejects every six-field mismatch without changing either duplicate state', async () => {
  const inline = row('1', 8);
  const mismatches: Array<{ name: string; value: Partial<DetachedFixture> }> = [
    { name: 'schema version', value: { schemaVersion: '1.0.0' } },
    { name: 'codec', value: { codec: 'X' } },
    { name: 'canonical length', value: { canonicalBytes: 7 } },
    { name: 'stored length', value: { storedBytes: 7 } },
    { name: 'SHA-256 bytes', value: { sha256: Buffer.alloc(32, 9) } },
    { name: 'payload bytes', value: { payload: Buffer.alloc(8, 9) } },
  ];
  for (const state of ['available', 'reclaiming'] as const) {
    for (const mismatch of mismatches) {
      const initial: DetachedFixture = { ...inline, ...mismatch.value, state };
      const fixture = statefulConnection([inline], initial);
      await assertCategory(
        new RevisionPayloadCutoverService().backfillBatch(fixture.connection, '0'),
        'checkpoint_integrity',
      );
      assert.deepEqual(fixture.detached(), initial, `${state}: ${mismatch.name}`);
      assert.equal(fixture.calls.length, 2, `${state}: ${mismatch.name}`);
      assert.equal(
        await new RevisionPayloadCutoverService().certifyParity(fixture.connection),
        false,
        `${state}: ${mismatch.name}`,
      );
      await assertCategory(
        new RevisionPayloadCutoverService().clearInlineBatch(fixture.connection, '0'),
        'checkpoint_integrity',
      );
      assert.deepEqual(fixture.detached(), initial, `${state}: ${mismatch.name}`);
    }
  }
});

test('backfill rejects malformed duplicate reads and write outcomes', async () => {
  const inline = row('1', 8);
  for (const scenario of [
    { name: 'duplicate read count', detachedRows: [{ ...inline }, { ...inline }], affectedRows: 1 },
    { name: 'insert no-op', detachedRows: [], affectedRows: 0 },
    { name: 'insert double effect', detachedRows: [], affectedRows: 2 },
    { name: 'insert non-integer', detachedRows: [], affectedRows: Number.NaN },
    {
      name: 'state transition no-op',
      detachedRows: [{ ...inline, state: 'reclaiming' }],
      affectedRows: 0,
    },
    {
      name: 'state transition double effect',
      detachedRows: [{ ...inline, state: 'reclaiming' }],
      affectedRows: 2,
    },
  ] as const) {
    const connection = {
      async execute(sql: string) {
        if (sql.includes('SELECT CAST(revision_pk AS CHAR)')) return [[inline], []];
        if (sql.includes('FROM board_revision_payloads')) return [scenario.detachedRows, []];
        return [{ affectedRows: scenario.affectedRows }, []];
      },
    } as unknown as PoolConnection;
    await assertCategory(
      new RevisionPayloadCutoverService().backfillBatch(connection, '0'),
      'row_integrity',
    );
  }
});

test('inline clear requires one exact available six-field tuple and refuses every invalid state', async () => {
  for (const scenario of [
    { name: 'missing detached row', affectedRows: 0 },
    { name: 'malformed detached row', affectedRows: 0 },
    { name: 'mismatched detached tuple', affectedRows: 0 },
    { name: 'matching reclaiming detached tuple', affectedRows: 0 },
    { name: 'matching available detached tuple', affectedRows: 1 },
  ]) {
    let updateSql = '';
    const connection = {
      async execute(sql: string) {
        if (sql.includes('FROM board_revisions')) return [[row('7', 8)], []];
        updateSql = sql;
        return [{ affectedRows: scenario.affectedRows }, []];
      },
    } as unknown as PoolConnection;
    const clear = new RevisionPayloadCutoverService().clearInlineBatch(connection, '6');
    if (scenario.affectedRows === 1)
      assert.deepEqual(await clear, { processed: 1, storedBytes: 8, nextRevisionPk: '7' });
    else await assert.rejects(clear, BoardPersistenceError, scenario.name);
    assert.match(updateSql, /p\.state = 'available'/u, scenario.name);
    for (const comparison of [
      'p.schema_version = r.scene_schema_version',
      'p.codec = r.scene_codec',
      'p.canonical_bytes = r.scene_canonical_bytes',
      'p.stored_bytes = r.scene_stored_bytes',
      'p.payload_sha256 = r.scene_sha256',
      'p.payload = r.scene_payload',
    ])
      assert.match(updateSql, new RegExp(comparison.replaceAll('.', '\\.'), 'u'), scenario.name);
  }
});

test('global parity requires one well-formed zero result and includes detached state', async () => {
  for (const [rows, expected] of [
    [[{ missingDetached: '0', parityMismatch: '0' }], true],
    [[{ missingDetached: 0, parityMismatch: 0 }], true],
    [[{ missingDetached: '1', parityMismatch: '0' }], false],
    [[{ missingDetached: '0', parityMismatch: '1' }], false],
    [[{ missingDetached: null, parityMismatch: '0' }], false],
    [[{ missingDetached: '', parityMismatch: '0' }], false],
    [[], false],
  ] as const) {
    let certificationSql = '';
    const connection = {
      async execute(sql: string) {
        certificationSql = sql;
        return [rows, []];
      },
    } as unknown as PoolConnection;
    assert.equal(await new RevisionPayloadCutoverService().certifyParity(connection), expected);
    assert.match(certificationSql, /p\.state <> 'available'/u);
    assert.equal((certificationSql.match(/COALESCE\(SUM/gu) ?? []).length, 2);
  }
});
