import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { RetainedHistoryMetadataParserV1 } from '../src/index.js';

const fixture = async (kind: 'valid' | 'invalid'): Promise<unknown> =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/${kind}/history-retained-metadata.v1.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

test('accepts the exact retained history metadata fixture and canonicalizes it', async () => {
  const parsed = RetainedHistoryMetadataParserV1.parse(await fixture('valid'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.value.entries[0]?.label, 'Revision 40');
  assert.equal(parsed.data.value.navigation?.previous?.kind, 'truncated');
});

test('rejects bidi/control text, unknown fields, and open actor labels', async () => {
  assert.equal(RetainedHistoryMetadataParserV1.parse(await fixture('invalid')).ok, false);
  const valid = (await fixture('valid')) as Record<string, unknown>;
  assert.equal(RetainedHistoryMetadataParserV1.parse({ ...valid, extra: true }).ok, false);
  const entries = valid.entries as Array<Record<string, unknown>>;
  assert.equal(
    RetainedHistoryMetadataParserV1.parse({
      ...valid,
      entries: [{ ...entries[0], actorLabel: 'administrator' }],
    }).ok,
    false,
  );
});
