import assert from 'node:assert/strict';
import test from 'node:test';
import { type Locator } from 'playwright';
import { launchBrowser } from './browser-engine';

const boardUrl = process.env.SCENEBOARD_BROWSER_BOARD_URL;
const storageState = process.env.SCENEBOARD_BROWSER_STORAGE_STATE;

async function assertReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const focusOutline = getComputedStyle(element).outlineWidth;
    let ancestor = element.parentElement;
    let clipped = false;
    while (ancestor !== null) {
      const style = getComputedStyle(ancestor);
      if (
        (style.overflowY === 'clip' || style.overflowY === 'hidden') &&
        ancestor.getBoundingClientRect().bottom < rect.bottom
      ) {
        clipped = true;
      }
      ancestor = ancestor.parentElement;
    }
    return { rect, focusOutline, clipped };
  });
  assert.equal(result.clipped, false);
  assert.ok(result.rect.height > 0);
}

test(
  'SceneBoard route reserves vertical scrolling for PAGE and keeps terminal content reachable',
  { skip: boardUrl === undefined || storageState === undefined },
  async () => {
    assert.ok(boardUrl);
    assert.ok(storageState);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        storageState,
      });
      await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-page-scroll-owner="PAGE"]').waitFor();
      const candidates = page.locator(
        [
          '[data-page-scroll-owner]',
          '.board-workspace',
          '.board-surface',
          '.scene-root',
          '.scene-layout',
          '.scene-tab-panel',
          '.scene-canvas-stage',
          '.scene-canvas-child',
          '.artifact-frame-container',
          '.scene-drawing-viewport',
          '.scene-table-scroll',
          '.scene-canvas-list',
        ].join(','),
      );
      const owners = await candidates.evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            return (
              (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
              element.scrollHeight > element.clientHeight
            );
          })
          .map((element) => element.getAttribute('data-page-scroll-owner')),
      );
      assert.equal(await page.locator('[data-page-scroll-owner="PAGE"]').count(), 1);
      assert.equal(
        owners.every((owner) => owner === 'PAGE'),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      const terminal = page.locator(
        '.scene-code:last-child, .scene-table-wrap:last-child, .scene-canvas-list:last-child, .scene-block:last-child',
      );
      for (let index = 0; index < (await terminal.count()); index += 1) {
        await assertReachable(terminal.nth(index));
      }
      const clippingValues = await candidates.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return [style.overflowX, style.overflowY];
        }),
      );
      assert.ok(clippingValues.every(([x]) => x !== 'scroll' && x !== 'auto'));
    } finally {
      await browser.close();
    }
  },
);
