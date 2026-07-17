import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RAW_BODY_PROFILES } from '../../src/common/http/raw-body-profiles.js';

test('MCP connection route is mounted once with one no-body profile and shared modules', async () => {
  const appSource = await readFile(new URL('../../src/app.module.ts', import.meta.url), 'utf8');
  const moduleSource = await readFile(new URL('../../src/mcp/mcp.module.ts', import.meta.url), 'utf8');
  assert.equal(appSource.match(/McpModule/g)?.length, 2);
  assert.equal(moduleSource.includes('BoardModule'), true);
  assert.equal(moduleSource.includes('PresenceModule'), true);
  const profiles = RAW_BODY_PROFILES.filter((profile) => profile.pathTemplate === '/api/v1/mcp/connection');
  assert.deepEqual(profiles, [{ kind: 'd1-no-body', method: 'GET', pathTemplate: '/api/v1/mcp/connection' }]);
});

test('connection controller uses the shared board principal and request correlation guards', async () => {
  const source = await readFile(new URL('../../src/mcp/mcp-connection.controller.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('@RequireBoardPrincipal()'), true);
  assert.equal(source.includes('admitBoardRequestId'), true);
  assert.equal(source.includes('process.env'), false);
});
