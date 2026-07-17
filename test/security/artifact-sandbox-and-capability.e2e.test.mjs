import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/artifact-sandbox-and-capability.e2e.test.mjs',
  clusters: ['ARTIFACT_QUOTA', 'ARTIFACT_POLICY', 'ARTIFACT_HOSTILE'],
  expectedCounts: { ARTIFACT_QUOTA: 8, ARTIFACT_POLICY: 16, ARTIFACT_HOSTILE: 12 },
});
