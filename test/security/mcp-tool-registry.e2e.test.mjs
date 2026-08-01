import { registerLiveGatedCatalogRows } from './security-catalog.test-helper.mjs';

await registerLiveGatedCatalogRows({
  testFile: 'test/security/mcp-tool-registry.e2e.test.mjs',
  clusters: ['MCP', 'MCP_ACCOUNT_API_KEY'],
  expectedCounts: { MCP: 123, MCP_ACCOUNT_API_KEY: 89 },
});
