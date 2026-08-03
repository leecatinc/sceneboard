import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BoardSnapshotParserV1,
  MAX_MEDIA_PIXELS,
  type BoardPageV2,
  type BoardSnapshotV1,
} from '@sceneboard/board-schema';
import { inspectExportReadinessV1 } from '@sceneboard/artifact-runtime/export';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BoardRenderer, PublicBoardRenderer, type MediaResolverV1 } from '../src/renderer/index.js';
import { renderImageBlockV1, type ImageStateV1 } from '../src/renderer/blocks/ImageBlock.js';
import {
  EXPORT_TRUSTED_IMAGE_URL_V1,
  type RendererComponentV1,
} from '../src/renderer/renderer-types.js';
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
    calls.map((input) => ({
      mediaId: 'mediaId' in input ? input.mediaId : null,
      pageId: input.pageId,
    })),
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

test('decorative media is hidden and ordinary artifact images retain their stable placeholder', () => {
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

const findElement = (
  node: ReactNode,
  type: string,
): ReactElement<Record<string, unknown>> | null => {
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type);
    if (found !== null) return found;
  }
  return null;
};

const eventRender = (
  page: BoardPageV2,
  resolver: MediaResolverV1,
  state: ImageStateV1 | null,
  setState: (next: ImageStateV1) => void,
  requestKeyRef: { current: string },
) =>
  renderImageBlockV1(
    {
      node: page.scene.root,
      context: {
        ...accountContext(page),
        revisionId: snapshot.revision.revisionId,
        selectedTabs: {},
        mediaResolver: resolver,
      },
      renderNode: () => null,
    } as Parameters<RendererComponentV1<'content.image'>>[0],
    state,
    setState,
    requestKeyRef,
  );

const exportReadinessFromMarkup = (markup: string) =>
  inspectExportReadinessV1({
    querySelector: (selector: string) =>
      selector === '[data-export-unsupported]' && markup.includes('data-export-unsupported')
        ? {}
        : selector === '[data-export-pending]' && markup.includes('data-export-pending')
          ? {}
          : null,
    querySelectorAll: (selector: string) =>
      selector === 'img' && markup.includes('<img') ? [{ complete: true, naturalWidth: 1 }] : [],
  } as unknown as ParentNode);

const artifactImagePage = (): BoardPageV2 =>
  ({
    ...imagePage('contain'),
    scene: {
      protocolVersion: 1,
      type: 'scene',
      root: {
        id: 'artifact_image',
        type: 'content.image',
        source: {
          type: 'artifact.resource',
          artifact: { artifactId: 'artifact_01', versionId: 'version_01' },
          path: 'preview.png',
          sha256: 'b'.repeat(64),
        },
        alt: 'Artifact image',
        fit: 'contain',
      },
    },
  }) as BoardPageV2;

test('trusted broker and artifact image events fail export readiness closed at decoded bounds', () => {
  const brokerPage = imagePage('contain');
  const artifactPage = artifactImagePage();
  const cases = [
    {
      name: 'broker',
      page: brokerPage,
      resolver: (() => ({
        url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${'a'.repeat(64)}`,
        [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'broker', sha256: 'a'.repeat(64) },
      })) as MediaResolverV1,
    },
    {
      name: 'artifact',
      page: artifactPage,
      resolver: (() => ({
        url: 'data:image/png;base64,iVBORw0KGgo=',
        [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: 'b'.repeat(64) },
      })) as MediaResolverV1,
    },
  ];
  for (const scenario of cases) {
    for (const event of [
      { name: 'error', fire: (props: Record<string, unknown>) => (props.onError as () => void)() },
      {
        name: 'zero dimensions',
        fire: (props: Record<string, unknown>) =>
          (props.onLoad as (event: unknown) => void)({
            currentTarget: { naturalWidth: 0, naturalHeight: 1 },
          }),
      },
      {
        name: 'pixel boundary + 1',
        fire: (props: Record<string, unknown>) =>
          (props.onLoad as (event: unknown) => void)({
            currentTarget: { naturalWidth: MAX_MEDIA_PIXELS + 1, naturalHeight: 1 },
          }),
      },
    ]) {
      let state: ImageStateV1 | null = null;
      const requestKeyRef = { current: '' };
      const initial = eventRender(
        scenario.page,
        scenario.resolver,
        state,
        (next) => {
          state = next;
        },
        requestKeyRef,
      );
      const image = findElement(initial, 'img');
      assert.ok(image, `${scenario.name} ${event.name}`);
      event.fire(image.props);
      const terminal = renderToStaticMarkup(
        eventRender(scenario.page, scenario.resolver, state, () => undefined, requestKeyRef),
      );
      assert.match(terminal, /data-export-unsupported/u, `${scenario.name} ${event.name}`);
      assert.doesNotMatch(terminal, /data-public-render-terminal/u);
      assert.deepEqual(exportReadinessFromMarkup(terminal), {
        ready: false,
        reason: 'unsupported',
      });
    }
  }
});

test('exact pixel boundary passes, stale events are ignored, and ordinary image fallback is unchanged', () => {
  const page = imagePage('contain');
  let digest = 'a'.repeat(64);
  const trustedResolver: MediaResolverV1 = () => ({
    url: `http://127.0.0.1:3411/internal/v1/export-render/${'s'.repeat(22)}/resources/${digest}`,
    [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'broker', sha256: digest },
  });
  let state: ImageStateV1 | null = null;
  const requestKeyRef = { current: '' };
  const first = eventRender(page, trustedResolver, state, (next) => (state = next), requestKeyRef);
  const firstImage = findElement(first, 'img');
  assert.ok(firstImage);
  (firstImage.props.onLoad as (event: unknown) => void)({
    currentTarget: { naturalWidth: 8_000, naturalHeight: 5_000 },
  });
  const boundary = renderToStaticMarkup(
    eventRender(page, trustedResolver, state, () => undefined, requestKeyRef),
  );
  assert.match(boundary, /<img/u);
  assert.doesNotMatch(boundary, /data-export-unsupported/u);

  const artifactPage = artifactImagePage();
  let artifactDigest = 'b'.repeat(64);
  let artifactUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const artifactResolver: MediaResolverV1 = () => ({
    url: artifactUrl,
    [EXPORT_TRUSTED_IMAGE_URL_V1]: { kind: 'artifact', sha256: artifactDigest },
  });
  let artifactState: ImageStateV1 | null = null;
  const artifactRef = { current: '' };
  const artifactBoundaryInitial = eventRender(
    artifactPage,
    artifactResolver,
    artifactState,
    (next) => (artifactState = next),
    artifactRef,
  );
  const artifactBoundaryImage = findElement(artifactBoundaryInitial, 'img');
  assert.ok(artifactBoundaryImage);
  (artifactBoundaryImage.props.onLoad as (event: unknown) => void)({
    currentTarget: { naturalWidth: 8_000, naturalHeight: 5_000 },
  });
  const artifactBoundary = renderToStaticMarkup(
    eventRender(artifactPage, artifactResolver, artifactState, () => undefined, artifactRef),
  );
  assert.match(artifactBoundary, /<img/u);
  assert.doesNotMatch(artifactBoundary, /data-export-unsupported/u);

  state = null;
  const stale = eventRender(page, trustedResolver, state, (next) => (state = next), requestKeyRef);
  const staleImage = findElement(stale, 'img');
  assert.ok(staleImage);
  digest = 'c'.repeat(64);
  eventRender(page, trustedResolver, state, (next) => (state = next), requestKeyRef);
  (staleImage.props.onError as () => void)();
  assert.equal(state, null);

  artifactState = null;
  const staleArtifact = eventRender(
    artifactPage,
    artifactResolver,
    artifactState,
    (next) => (artifactState = next),
    artifactRef,
  );
  const staleArtifactImage = findElement(staleArtifact, 'img');
  assert.ok(staleArtifactImage);
  artifactDigest = 'd'.repeat(64);
  artifactUrl = 'data:image/png;base64,iVBORw0KGgs=';
  eventRender(
    artifactPage,
    artifactResolver,
    artifactState,
    (next) => (artifactState = next),
    artifactRef,
  );
  (staleArtifactImage.props.onError as () => void)();
  assert.equal(artifactState, null);

  const ordinary: MediaResolverV1 = () => ({ url: '/api/v1/media/image.png' });
  const ordinaryRef = { current: '' };
  const ordinaryInitial = eventRender(page, ordinary, null, (next) => (state = next), ordinaryRef);
  const ordinaryImage = findElement(ordinaryInitial, 'img');
  assert.ok(ordinaryImage);
  (ordinaryImage.props.onError as () => void)();
  const ordinaryTerminal = renderToStaticMarkup(
    eventRender(page, ordinary, state, () => undefined, ordinaryRef),
  );
  assert.match(ordinaryTerminal, /data-public-render-terminal="true"/u);
  assert.doesNotMatch(ordinaryTerminal, /data-export-unsupported/u);
  assert.deepEqual(exportReadinessFromMarkup(ordinaryTerminal), { ready: true });
});
