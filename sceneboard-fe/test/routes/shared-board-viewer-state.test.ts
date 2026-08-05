import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PublicShareStateParserV1, type PublicShareStateV1 } from '@sceneboard/board-schema';

import {
  PUBLIC_SHARE_EARLY_REFRESH_MS_V1,
  PUBLIC_SHARE_HARD_EXPIRY_MS_V1,
  publicShareAnnotationPageKeyV1,
  publicShareArtifactRouteKeyV1,
  publicShareProjectionTupleMatchesV1,
  publicShareViewerDeadlinesV1,
  publicShareViewerIdentityV1,
  samePublicShareViewerIdentityV1,
} from '../../lib/board/public-share-viewer-state';

const parsed = PublicShareStateParserV1.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/board-schema/test/fixtures/valid/public-share-ready.v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as unknown,
);
if (!parsed.ok || parsed.data.value.state !== 'ready')
  throw new TypeError('public share fixture is invalid');
const ready = parsed.data.value;

test('viewer deadlines are derived only from the captured monotonic request start', () => {
  assert.deepEqual(publicShareViewerDeadlinesV1(12_345), {
    earlyRefreshAt: 12_345 + PUBLIC_SHARE_EARLY_REFRESH_MS_V1,
    hardExpiryAt: 12_345 + PUBLIC_SHARE_HARD_EXPIRY_MS_V1,
  });
  assert.equal(PUBLIC_SHARE_EARLY_REFRESH_MS_V1, 30_000);
  assert.equal(PUBLIC_SHARE_HARD_EXPIRY_MS_V1, 55_000);
  assert.throws(() => publicShareViewerDeadlinesV1(Number.NaN));
});

test('late work requires exact route, context, tuple, and request identity', () => {
  const identity = publicShareViewerIdentityV1('route-a', ready, 7);
  assert.equal(samePublicShareViewerIdentityV1(identity, { ...identity }), true);
  assert.equal(samePublicShareViewerIdentityV1(identity, { ...identity, requestEpoch: 8 }), false);
  assert.equal(
    samePublicShareViewerIdentityV1(identity, { ...identity, contextId: 'B'.repeat(43) }),
    false,
  );
});

test('ready revalidation preserves the exact pinned projection tuple', () => {
  assert.equal(publicShareProjectionTupleMatchesV1(ready, ready), true);
  const drifted = {
    ...ready,
    projection: { ...ready.projection, accessGeneration: 2 },
  } as Extract<PublicShareStateV1, { state: 'ready' }>;
  assert.equal(publicShareProjectionTupleMatchesV1(ready, drifted), false);
});

test('annotation page identity survives context renewal but changes with the pinned page tuple', () => {
  const pageId = ready.projection.document.pages[0]!.pageId;
  const renewed = {
    ...ready,
    context: { ...ready.context, contextId: 'B'.repeat(43) },
  } as Extract<PublicShareStateV1, { state: 'ready' }>;
  assert.equal(
    publicShareAnnotationPageKeyV1(ready, pageId),
    publicShareAnnotationPageKeyV1(renewed, pageId),
  );
  assert.notEqual(
    publicShareAnnotationPageKeyV1(ready, pageId),
    publicShareAnnotationPageKeyV1(ready, 'page-other'),
  );
});

test('artifact route identity survives context renewal but changes with the pinned projection tuple', () => {
  const renewed = {
    ...ready,
    context: { ...ready.context, contextId: 'B'.repeat(43) },
  } as Extract<PublicShareStateV1, { state: 'ready' }>;
  assert.equal(publicShareArtifactRouteKeyV1(ready), publicShareArtifactRouteKeyV1(renewed));
  assert.notEqual(
    publicShareArtifactRouteKeyV1(ready),
    publicShareArtifactRouteKeyV1({
      ...ready,
      projection: {
        ...ready.projection,
        publicationGeneration: ready.projection.publicationGeneration + 1,
      },
    } as Extract<PublicShareStateV1, { state: 'ready' }>),
  );
});
