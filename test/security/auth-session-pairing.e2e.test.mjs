import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/auth-session-pairing.e2e.test.mjs',
  clusters: ['AUTH_SESSION', 'PAIRING'],
  expectedCounts: { AUTH_SESSION: 18, PAIRING: 33 },
});
