import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGES, SUPPORTED_LOCALES, messageKeys } from '../../lib/i18n/catalog';
import { ANALYTICS_CATALOG } from '../../lib/i18n/catalogs/analytics';

test('analytics owns one complete non-empty localized topic', () => {
  const keys = ANALYTICS_CATALOG.map((row) => row[0]);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    messageKeys().filter((key) => key.startsWith('analytics.')),
    keys,
  );
  for (const locale of SUPPORTED_LOCALES)
    for (const key of keys) assert.ok(MESSAGES[locale][key].trim().length > 0, `${locale}:${key}`);
});
