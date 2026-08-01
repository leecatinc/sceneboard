import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
  clusters: ['AUTH_SESSION', 'PAIRING', 'ACCOUNT_API_KEY_AUTHENTICATION'],
  expectedCounts: { AUTH_SESSION: 18, PAIRING: 33, ACCOUNT_API_KEY_AUTHENTICATION: 8 },
});
