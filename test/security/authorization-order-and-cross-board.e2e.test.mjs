import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
  clusters: ['AUTHORIZATION'],
  expectedCounts: { AUTHORIZATION: 51 },
});
