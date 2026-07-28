import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('shared-viewer route closes server, client, renderer, lifecycle, and document-policy seams', () => {
  const page = read('sceneboard-fe/app/s/[shareToken]/page.tsx');
  const actions = read('sceneboard-fe/app/s/[shareToken]/shared-board-actions.ts');
  const client = read('sceneboard-fe/app/s/[shareToken]/shared-board-client.tsx');
  const lifecycle = read('sceneboard-fe/lib/board/public-share-viewer-state.ts');
  const renderer = read('packages/board-ui/src/renderer/PublicBoardRenderer.tsx');
  const middleware = read('sceneboard-fe/middleware.ts');
  assert.match(page, /bootstrapSharedBoard\.bind/u);
  assert.match(actions, /admitPublicSharePasswordServer/u);
  assert.match(client, /fetchPublicShareRevalidation/u);
  assert.match(client, /PresentationStage/u);
  assert.match(lifecycle, /30_000/u);
  assert.match(lifecycle, /55_000/u);
  assert.match(renderer, /RenderSceneTree/u);
  assert.match(middleware, /private,no-store/u);
  assert.match(middleware, /nonce-/u);
});
