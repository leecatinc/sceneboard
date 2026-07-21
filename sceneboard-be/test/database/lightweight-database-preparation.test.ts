import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLightweightDatabasePreparationAllowed } from '../../scripts/prepare-lightweight-database.js';

const valid = {
  APP_ENV: 'development',
  NODE_ENV: 'development',
  MYSQL_DATABASE: 'sceneboard',
  CONFIRM_LIGHTWEIGHT_DB_PREPARE: 'I_CONFIRM_CREATE_OR_MIGRATE_SCENEBOARD_DEVELOPMENT_SCHEMA',
};

test('accepts only the explicitly confirmed SceneBoard development schema', () => {
  assert.doesNotThrow(() => assertLightweightDatabasePreparationAllowed(valid));
  assert.throws(() =>
    assertLightweightDatabasePreparationAllowed({ ...valid, APP_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLightweightDatabasePreparationAllowed({ ...valid, NODE_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLightweightDatabasePreparationAllowed({ ...valid, MYSQL_DATABASE: 'other' }),
  );
  assert.throws(() =>
    assertLightweightDatabasePreparationAllowed({ ...valid, CONFIRM_LIGHTWEIGHT_DB_PREPARE: 'no' }),
  );
});
