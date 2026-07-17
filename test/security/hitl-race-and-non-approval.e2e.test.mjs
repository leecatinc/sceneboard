import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/hitl-race-and-non-approval.e2e.test.mjs',
  clusters: ['HITL_STATE', 'HITL_RACE', 'HITL_EXPIRY', 'HITL_DESTRUCTIVE', 'HITL_LIVE_HISTORY', 'SCENE_NONINTERACTIVE'],
  expectedCounts: {
    HITL_STATE: 20,
    HITL_RACE: 3,
    HITL_EXPIRY: 3,
    HITL_DESTRUCTIVE: 6,
    HITL_LIVE_HISTORY: 4,
    SCENE_NONINTERACTIVE: 2,
  },
});
