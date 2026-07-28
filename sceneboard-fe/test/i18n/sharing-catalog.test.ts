import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGES, SUPPORTED_LOCALES, messageKeys } from '../../lib/i18n/catalog';
import { SHARING_CATALOG } from '../../lib/i18n/catalogs/sharing';

test('sharing owns one complete non-empty localized topic', () => {
  const keys = SHARING_CATALOG.map((row) => row[0]);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    messageKeys().filter((key) => key.startsWith('sharing.')),
    keys,
  );
  for (const locale of SUPPORTED_LOCALES)
    for (const key of keys) assert.ok(MESSAGES[locale][key].trim().length > 0, `${locale}:${key}`);
});
