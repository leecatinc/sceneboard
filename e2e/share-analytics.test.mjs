import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('visible public analytics maps intents to canonical rolling identities', () => {
  const client = read('sceneboard-fe/app/s/[shareToken]/shared-board-client.tsx');
  const visible = read('sceneboard-fe/lib/share-analytics/visible-signal.ts');
  const event = read('sceneboard-be/src/share-analytics/event/share-analytics-event.service.ts');
  assert.match(client, /'first-visible'/u);
  assert.match(client, /'page-visible'/u);
  assert.match(visible, /visibilityState !== 'visible'/u);
  assert.match(visible, /requestAnimationFrame/u);
  assert.match(event, /metricKind: 'board-open'/u);
  assert.match(event, /metricKind: 'page-view'/u);
  assert.match(event, /30 \* 60 \* 1_000/u);
  assert.match(event, /replayed: true/u);
  assert.match(event, /replayed: false/u);
});

test('analytics stays public-share-only and stores no raw request identity', () => {
  const moduleSource = read('sceneboard-be/src/share-analytics/share-analytics.module.ts');
  const classifier = read('sceneboard-be/src/share-analytics/context/share-view-classifier.ts');
  const panel = read('sceneboard-fe/components/board/ShareAnalyticsPanel.tsx');
  const ownerClient = read('sceneboard-fe/app/boards/[boardId]/board-client.tsx');
  assert.match(moduleSource, /ShareAnalyticsController/u);
  assert.match(classifier, /bot\|crawler\|spider/u);
  assert.match(ownerClient, /affordances\['analytics\.read'\]/u);
  assert.match(panel, /if \(!enabled\) return null/u);
  assert.doesNotMatch(panel, /public.*badge|badge.*public/iu);
  for (const forbidden of ['ip_address', 'user_agent_raw', 'account_id', 'share_token'])
    assert.doesNotMatch(moduleSource, new RegExp(forbidden, 'iu'));
});
