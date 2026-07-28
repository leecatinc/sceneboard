import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardSnapshotParserV1,
  type BoardPageV2,
  type BoardSnapshotV1,
} from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import { BoardRenderer, PublicBoardRenderer, type MediaResolverV1 } from '../src/renderer/index.js';
import { rendererTestInputV2 } from './renderer-test-input.js';

const snapshotInput = JSON.parse(
  readFileSync(
    new URL('../../board-schema/test/fixtures/valid/snapshot-board.v1.json', import.meta.url),
    'utf8',
  ),
) as unknown;
const parsedSnapshot = BoardSnapshotParserV1.parse(snapshotInput);
if (!parsedSnapshot.ok) throw new TypeError('snapshot fixture is invalid');
const snapshot = parsedSnapshot.data.value as BoardSnapshotV1;

const imagePage = (fit: 'contain' | 'cover' | 'fill' | 'none', decorative = false): BoardPageV2 =>
  ({
    pageId: 'page_media',
    title: 'Media',
    displayMode: 'fit-page',
    scene: {
      protocolVersion: 1,
      type: 'scene',
      root: {
        id: 'image_media',
        type: 'content.image',
        source: { type: 'media', mediaId: 'media_01' },
        ...(decorative ? { decorative: true } : {}),
        alt: decorative ? '' : 'Accessible description',
        ...(decorative ? {} : { caption: 'Semantic caption' }),
        fit,
      },
    },
  }) as BoardPageV2;

const accountContext = (page: BoardPageV2) => ({
  ...rendererTestInputV2(snapshot).context,
  selectedPageId: page.pageId,
});

const READY_RESOLVER: MediaResolverV1 = () => ({
  url: '/api/v1/boards/board_01/revisions/revision_01/media/media_01',
  metadata: {
    mime: 'image/png',
    width: 1_200,
    height: 675,
    etag: `"sha256-${'a'.repeat(64)}"`,
  },
});

test('media images traverse the one account and public renderer tree through the host resolver', () => {
  const page = imagePage('cover');
  const calls: Parameters<MediaResolverV1>[0][] = [];
  const resolver: MediaResolverV1 = (input) => {
    calls.push(input);
    return READY_RESOLVER(input);
  };
  const account = renderToStaticMarkup(
    <BoardRenderer page={page} context={accountContext(page)} mediaResolver={resolver} />,
  );
  const publicMarkup = renderToStaticMarkup(
    <PublicBoardRenderer
      page={page}
      mediaResolver={resolver}
      context={{
        surface: 'public-share',
        boardId: snapshot.boardId,
        revisionId: snapshot.revision.revisionId,
        publicationGeneration: 1,
        accessGeneration: 1,
        artifacts: [],
        media: [],
        selectedPageId: page.pageId,
      }}
    />,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ mediaId, pageId }) => ({ mediaId, pageId })),
    [
      { mediaId: 'media_01', pageId: 'page_media' },
      { mediaId: 'media_01', pageId: 'page_media' },
    ],
  );
  for (const markup of [account, publicMarkup]) {
    assert.match(markup, /<img/u);
    assert.match(markup, /alt="Accessible description"/u);
    assert.match(markup, /Semantic caption/u);
    assert.match(markup, /data-fit="cover"/u);
    assert.match(markup, /--scene-image-aspect-ratio:1_?200 \/ 675|1200 \/ 675/u);
    assert.match(markup, /aria-busy="true"/u);
  }
});

test('all four fit modes are explicit and resolver denial never assigns img src', () => {
  for (const fit of ['contain', 'cover', 'fill', 'none'] as const) {
    const page = imagePage(fit);
    const markup = renderToStaticMarkup(
      <BoardRenderer page={page} context={accountContext(page)} mediaResolver={READY_RESOLVER} />,
    );
    assert.match(markup, new RegExp(`data-fit="${fit}"`, 'u'));
  }
  const page = imagePage('contain');
  for (const resolver of [undefined, () => ({ error: 'unavailable' as const })]) {
    const markup = renderToStaticMarkup(
      <BoardRenderer
        page={page}
        context={accountContext(page)}
        {...(resolver === undefined ? {} : { mediaResolver: resolver })}
      />,
    );
    assert.doesNotMatch(markup, /<img|src=/u);
    assert.match(markup, /role="img"/u);
    assert.match(markup, /aria-label="Accessible description"/u);
    assert.match(markup, /Image unavailable/u);
  }
});

test('decorative media is hidden and legacy artifact image behavior remains a placeholder', () => {
  const decorative = imagePage('contain', true);
  const decorativeMarkup = renderToStaticMarkup(
    <BoardRenderer
      page={decorative}
      context={accountContext(decorative)}
      mediaResolver={READY_RESOLVER}
    />,
  );
  assert.match(decorativeMarkup, /aria-hidden="true"/u);
  assert.match(decorativeMarkup, /alt=""/u);

  const artifactPage = {
    ...imagePage('contain'),
    scene: {
      protocolVersion: 1,
      type: 'scene',
      root: {
        id: 'image_artifact',
        type: 'content.image',
        source: {
          type: 'artifact.resource',
          artifact: { artifactId: 'artifact_01', versionId: 'version_01' },
          path: 'preview.png',
          sha256: 'a'.repeat(64),
        },
        alt: 'Legacy image',
        fit: 'contain',
      },
    },
  } as BoardPageV2;
  const artifactMarkup = renderToStaticMarkup(
    <BoardRenderer page={artifactPage} context={accountContext(artifactPage)} />,
  );
  assert.doesNotMatch(artifactMarkup, /<img/u);
  assert.match(artifactMarkup, /Verified image delivery is unavailable in this release/u);
  assert.match(artifactMarkup, /Artifact status: unavailable/u);
});

test('image CSS inherits PAGE ownership and actual-size measurement observes decoded width', () => {
  const css = readFileSync(
    new URL('../../../sceneboard-fe/app/globals.css', import.meta.url),
    'utf8',
  );
  const stage = readFileSync(
    new URL('../../../sceneboard-fe/components/board/PresentationStage.tsx', import.meta.url),
    'utf8',
  );
  const imageRules = css.slice(css.indexOf('.scene-image {'), css.indexOf('.scene-progress-head'));
  assert.match(imageRules, /\[data-page-display-mode='actual-size'\][\s\S]*data-fit='none'/u);
  assert.match(imageRules, /object-fit: contain/u);
  assert.match(imageRules, /object-fit: cover/u);
  assert.match(imageRules, /object-fit: fill/u);
  assert.match(imageRules, /object-fit: none/u);
  assert.doesNotMatch(imageRules, /overflow:\s*(?:auto|scroll)|transform:|touch-action:/u);
  assert.match(stage, /content\.scrollWidth/u);
  assert.match(stage, /addEventListener\('load', measure, true\)/u);
  assert.match(stage, /removeEventListener\('load', measure, true\)/u);
});
