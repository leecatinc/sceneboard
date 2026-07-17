import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
  clusters: ['MCP'],
  expectedCounts: { MCP: 87 },
});
