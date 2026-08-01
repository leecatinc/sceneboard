import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/secret-canary.e2e.test.mjs',
  clusters: ['SECRET_CANARY'],
  expectedCounts: { SECRET_CANARY: 156 },
});
