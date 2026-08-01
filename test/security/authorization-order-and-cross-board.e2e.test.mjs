import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/authorization-order-and-cross-board.e2e.test.mjs',
  clusters: ['AUTHORIZATION', 'ACCOUNT_API_KEY_AUTHORIZATION', 'ACCOUNT_API_KEY_EXPORT'],
  expectedCounts: {
    AUTHORIZATION: 51,
    ACCOUNT_API_KEY_AUTHORIZATION: 36,
    ACCOUNT_API_KEY_EXPORT: 8,
  },
});
