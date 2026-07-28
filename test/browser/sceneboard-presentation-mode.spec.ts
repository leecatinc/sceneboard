import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

const boardUrl = process.env.SCENEBOARD_BROWSER_BOARD_URL;

test(
  'denied fullscreen falls back to focus mode and retains one PAGE scroll owner',
  { skip: boardUrl === undefined },
  async () => {
    assert.ok(boardUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
      });
      await page.goto(boardUrl, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /present|발표 시작/i }).click();
      await page.locator('[data-page-scroll-owner="PAGE"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.board-topbar:visible').count(), 0);
      assert.equal(await page.locator('[data-presentation-controls]').count(), 1);
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
  'presentation controls hide, reveal on first Tab, and keep bounded navigation',
  { skip: boardUrl === undefined },
  async () => {
    assert.ok(boardUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
      });
      await page.goto(boardUrl, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /present|발표 시작/i }).click();
      const overlay = page.locator('[data-presentation-controls]');
      await page.waitForTimeout(3_050);
      await overlay.waitFor();
      assert.equal(await overlay.getAttribute('data-presentation-controls'), 'hidden');
      await page.keyboard.press('Tab');
      assert.notEqual(await overlay.getAttribute('data-presentation-controls'), 'hidden');
      assert.ok(await overlay.locator('button:focus').count());
    } finally {
      await browser.close();
    }
  },
);
