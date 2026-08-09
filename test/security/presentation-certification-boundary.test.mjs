import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('presentation migration slots are exact through terminal 027 and later entries remain ordered', () => {
  const registry = read('sceneboard-be/src/database/migrations/registry.ts');
  const versions = [...registry.matchAll(/\bversion: '(\d{3})_/gu)]
    .map((match) => match[1])
    .filter((version) => Number(version) >= 13);
  const presentationVersions = versions.filter((version) => Number(version) <= 27);
  assert.deepEqual(presentationVersions, [
    '013',
    '014',
    '015',
    '016',
    '017',
    '018',
    '019',
    '020',
    '021',
    '022',
    '023',
    '024',
    '025',
    '026',
    '027',
  ]);
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(versions.slice(presentationVersions.length), ['028', '029', '030', '031']);
});

test('public analytics and MCP media sources contain no forbidden persistent path or identity sinks', () => {
  const analytics = [
    'sceneboard-be/src/share-analytics/context/share-analytics-context.service.ts',
    'sceneboard-be/src/share-analytics/context/viewer-identity.service.ts',
    'sceneboard-be/src/share-analytics/event/share-analytics-event.service.ts',
  ]
    .map(read)
    .join('\n');
  const media = read('sceneboard-mcp/src/tools/media.tools.ts');
  for (const canary of ['ip_address', 'raw_user_agent', 'account_id', 'share_token'])
    assert.doesNotMatch(analytics, new RegExp(canary, 'iu'));
  assert.doesNotMatch(
    media,
    /(?:result|response|error|log|state).{0,80}(?:realpath|input\.path)/iu,
  );
});
