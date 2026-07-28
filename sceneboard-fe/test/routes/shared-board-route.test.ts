import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('public route keeps the raw route secret inside the server entry and bound actions', () => {
  const page = source('app/s/[shareToken]/page.tsx');
  const actions = source('app/s/[shareToken]/shared-board-actions.ts');
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  assert.match(page, /bootstrapSharedBoard\.bind\(null, shareToken\)/u);
  assert.match(page, /submitSharedBoardPassword\.bind\(null, shareToken\)/u);
  assert.match(actions, /'use server'/u);
  assert.match(actions, /public-share-server/u);
  assert.doesNotMatch(client, /shareToken|cookieHeader|Set-Cookie|AppShell|AuthenticatedRoute/u);
  assert.doesNotMatch(client, /<BoardRenderer|history|presence|capabilities|renderHitl/u);
});

test('public route composes the shared renderer and finalized read-only controls', () => {
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  const styles = source('app/s/[shareToken]/shared-board.module.css');
  assert.match(client, /PublicBoardRenderer/u);
  assert.match(client, /PageNavigationControls/u);
  assert.match(client, /PresentationModeControls/u);
  assert.match(client, /surface: 'public-share'/u);
  assert.match(styles, /max-height:\s*100dvh/u);
  assert.match(styles, /overflow-y:\s*auto/u);
  assert.match(styles, /@media \(max-width: 320px\)/u);
});

test('capability loss and hard expiry share one clear-before-focus invalidation path', () => {
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  const clearIndex = client.indexOf("setAccepted({ state: { state: 'unavailable' }");
  const focusIndex = client.indexOf("focusState('[data-shared-unavailable-heading]')");
  assert.notEqual(clearIndex, -1);
  assert.notEqual(focusIndex, -1);
  assert.ok(clearIndex < focusIndex);
  assert.match(client, /requestAbortRef\.current\?\.abort\(\)/u);
  assert.match(client, /document\.exitFullscreen/u);
  assert.match(client, /document\.visibilityState === 'visible'/u);
});
