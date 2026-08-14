import assert from 'node:assert/strict';
import test from 'node:test';
import { type Page } from 'playwright';
import { launchBrowser } from './browser-engine';

const boardUrl = process.env.SCENEBOARD_BROWSER_BOARD_URL;
const storageState = process.env.SCENEBOARD_BROWSER_STORAGE_STATE;

const startPresentation = async (page: Page) => {
  const sessionsLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && response.url().includes('/presentation-sessions'),
  );
  await page.getByRole('button', { name: /present|발표 시작/i }).click();
  const sessionDialog = page.getByRole('dialog', {
    name: /live presentation|실시간 발표/iu,
  });
  await sessionDialog.waitFor({ state: 'visible' });
  await sessionsLoaded;
  const activeSession = sessionDialog.locator('ul button').first();
  if (await activeSession.isVisible().catch(() => false)) await activeSession.click();
  else
    await sessionDialog
      .getByRole('button', { name: /start new presentation|새 발표 시작/iu })
      .click();
};

test(
  'denied fullscreen falls back to focus mode and retains one PAGE scroll owner',
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
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
      });
      await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('.board-topbar').waitFor({ state: 'visible' });
      await startPresentation(page);
      await page.locator('[data-page-scroll-owner="PAGE"]').waitFor({ state: 'visible' });
      await page.locator('.board-topbar-presentation').waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('.board-topbar:not(.board-topbar-presentation):visible').count(),
        0,
      );
      assert.equal(await page.locator('.board-topbar-presentation').count(), 1);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await page.keyboard.press('Escape');
      await page.locator('.board-topbar').waitFor({ state: 'visible' });
    } finally {
      await browser.close();
    }
  },
);

test(
  'owner presentation exposes keyboard-reachable bounded controls',
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
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
      });
      await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('.board-topbar').waitFor({ state: 'visible' });
      await startPresentation(page);
      const presentationTopBar = page.locator('.board-topbar-presentation');
      await presentationTopBar.waitFor({ state: 'visible' });
      const focusedControl = presentationTopBar.locator('a:focus, button:focus');
      for (let index = 0; index < 12 && (await focusedControl.count()) === 0; index += 1)
        await page.keyboard.press('Tab');
      assert.equal(await focusedControl.count(), 1);
      const focusedBox = await focusedControl.boundingBox();
      assert.ok(focusedBox);
      assert.equal(
        focusedBox.x >= 0 &&
          focusedBox.y >= 0 &&
          focusedBox.x + focusedBox.width <= 1280 &&
          focusedBox.y + focusedBox.height <= 800,
        true,
      );
      await presentationTopBar
        .getByRole('button', { name: /exit presentation|발표 종료/iu })
        .click();
      await page.locator('.board-topbar:not(.board-topbar-presentation)').waitFor({
        state: 'visible',
      });
    } finally {
      await browser.close();
    }
  },
);
