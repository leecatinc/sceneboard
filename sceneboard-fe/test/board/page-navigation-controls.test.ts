import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PageNavigationControls } from '../../components/board/PageNavigationControls';

const renderControls = (current: number, total: number) =>
  renderToStaticMarkup(
    createElement(PageNavigationControls, {
      current,
      total,
      previousLabel: 'Previous page',
      nextLabel: 'Next page',
      statusLabel: 'Page navigation',
      onPrevious: () => undefined,
      onNext: () => undefined,
    }),
  );

test('one-page navigation stays hidden because there is nowhere to move', () => {
  const html = renderControls(1, 1);
  assert.equal(html, '');
});

test('multi-page controls expose bounded previous and next actions', () => {
  const first = renderControls(1, 3);
  const last = renderControls(3, 3);
  assert.match(first, /aria-label="Previous page" disabled/u);
  assert.doesNotMatch(first, /aria-label="Next page" disabled/u);
  assert.match(last, /aria-label="Next page" disabled/u);
  assert.doesNotMatch(last, /aria-label="Previous page" disabled/u);
});

test('production board route binds stable page identity, scroll owner, and capture admission', () => {
  const source = readFileSync(
    new URL('../../app/boards/[boardId]/board-client.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /key=\{`\$\{boardId\}:\$\{visibleSnapshot\.revision\.revisionId\}:\$\{resolvedPageId\}`\}/u,
  );
  assert.match(source, /page=\{pageRender\.page\}/u);
  assert.match(source, /context=\{pageRender\.context\}/u);
  assert.match(source, /<PresentationStage[\s\S]*?stageRef=\{bindPageStage\}/u);
  assert.match(source, /behavior: 'instant' as ScrollBehavior/u);
  assert.match(source, /hitlInteractionActive,\s*artifactCaptureActive,\s*moveCaptureActive/su);
});
