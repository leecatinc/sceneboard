import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/hostile-payload-corpus.e2e.test.mjs',
  clusters: ['CARRIER_BOUNDARY', 'SCHEMA_CORPUS'],
  expectedCounts: { CARRIER_BOUNDARY: 20, SCHEMA_CORPUS: 185 },
});
