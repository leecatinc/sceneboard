import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_MEDIA_PIXELS,
  PublicShareStateParserV1,
  PublicShareTokenParserV1,
} from '../src/index.js';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const document = {
  schemaVersion: 2,
  defaultPageId: 'page_a',
  pages: [
    {
      pageId: 'page_a',
      title: '',
      displayMode: 'fit-page',
      scene: { protocolVersion: 1, type: 'scene', root: null },
    },
  ],
};

const projection = {
  shareId: 'share_public_1',
  boardId: 'board_public_1',
  revisionId: 'revision_public_1',
  publicationGeneration: 2,
  accessGeneration: 3,
  title: 'Public board',
  document,
  artifacts: [
    {
      artifactId: 'artifact_1',
      versionId: 'version_1',
      status: 'ready',
      packageUrl: `/api/v1/public/shares/share_public_1/revisions/revision_public_1/g/2/3/artifacts/artifact_1/versions/version_1/package?contextId=${contextId}`,
    },
  ],
  media: [
    {
      mediaId: 'media_1',
      url: `/api/v1/public/shares/share_public_1/revisions/revision_public_1/g/2/3/media/media_1?contextId=${contextId}`,
      mime: 'image/webp',
      width: 2_000,
      height: 2_000,
      etag: `"sha256-${'a'.repeat(64)}"`,
    },
  ],
};

test('public references accept secret tokens and persistent generation-bound locators', () => {
  assert.equal(PublicShareTokenParserV1.parse(contextId).ok, true);
  assert.equal(PublicShareTokenParserV1.parse('share_abcdefghijklmnopqrstuv_g7').ok, true);
  assert.equal(PublicShareTokenParserV1.parse('share_abcdefghijklmnopqrstuv_g0').ok, false);
  assert.equal(PublicShareTokenParserV1.parse(`${contextId.slice(0, -1)}B`).ok, false);
  assert.equal(PublicShareTokenParserV1.parse(`${contextId}=`).ok, false);
});

test('ready projection pins exact token-free resource URLs and rejects secrets', () => {
  const ready = PublicShareStateParserV1.parse({
    state: 'ready',
    projection,
    context: { contextId, validUntil: '2026-07-28T00:01:00.000Z' },
  });
  assert.equal(ready.ok, true);
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'ready',
      projection: { ...projection, shareToken: contextId },
      context: { contextId, validUntil: '2026-07-28T00:01:00.000Z' },
    }).ok,
    false,
  );
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'ready',
      projection: {
        ...projection,
        artifacts: [
          {
            ...projection.artifacts[0],
            packageUrl: projection.artifacts[0]!.packageUrl.replace('/g/2/3/', '/g/2/4/'),
          },
        ],
      },
      context: { contextId, validUntil: '2026-07-28T00:01:00.000Z' },
    }).ok,
    false,
  );
});

test('public media metadata is strict, bounded, and deduplicated', () => {
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'ready',
      projection: {
        ...projection,
        media: [
          {
            ...projection.media[0],
            width: MAX_MEDIA_PIXELS,
            height: 2,
          },
        ],
      },
      context: { contextId, validUntil: '2026-07-28T00:01:00.000Z' },
    }).ok,
    false,
  );
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'ready',
      projection: { ...projection, media: [projection.media[0], projection.media[0]] },
      context: { contextId, validUntil: '2026-07-28T00:01:00.000Z' },
    }).ok,
    false,
  );
});

test('public non-ready states reject unknown metadata', () => {
  assert.equal(
    PublicShareStateParserV1.parse({ state: 'password-required', csrfToken: 'v1.token' }).ok,
    true,
  );
  assert.equal(PublicShareStateParserV1.parse({ state: 'unavailable' }).ok, true);
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'rate-limited',
      retryAfterSeconds: 900,
    }).ok,
    true,
  );
  assert.equal(
    PublicShareStateParserV1.parse({
      state: 'unavailable',
      shareId: 'share_public_1',
    }).ok,
    false,
  );
});
