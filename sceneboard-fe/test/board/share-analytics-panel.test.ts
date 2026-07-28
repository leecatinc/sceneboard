import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('owner analytics panel keeps server ordering and semantic responsive table ownership', () => {
  const component = source('components/board/ShareAnalyticsPanel.tsx');
  const css = source('components/board/ShareAnalyticsPanel.module.css');
  const boardClient = source('app/boards/[boardId]/board-client.tsx');
  assert.match(component, /<table>/u);
  assert.match(component, /<caption>/u);
  assert.match(component, /<th scope="col">/u);
  assert.match(component, /<th scope="row">/u);
  assert.match(component, /report\.publications\.map/u);
  assert.match(component, /publication\.pages\.map/u);
  assert.doesNotMatch(
    component.slice(component.indexOf('<tbody>')),
    /\.sort\(|\.slice\(|new Map|new Set/u,
  );
  assert.match(component, /pageReachBasisPoints === null[\s\S]*?'—'/u);
  assert.match(css, /\.tableViewport[\s\S]*overflow-x:\s*auto/u);
  assert.match(css, /@media \(max-width:\s*320px\)/u);
  assert.match(boardClient, /canReadShareAnalytics[\s\S]*?<OwnerAdminControls/u);
  assert.match(boardClient, /lost\.includes\('analytics\.read'\)/u);
});
