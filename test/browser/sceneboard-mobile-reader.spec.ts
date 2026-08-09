import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

const boardUrl = process.env.SCENEBOARD_BROWSER_BOARD_URL;
const storageState = process.env.SCENEBOARD_BROWSER_STORAGE_STATE;

test(
  '320px reader has zero document X overflow, 44px navigation, and an exclusive drawer owner',
  { skip: boardUrl === undefined || storageState === undefined },
  async () => {
    assert.ok(boardUrl);
    assert.ok(storageState);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 320, height: 640 },
        isMobile: true,
        hasTouch: true,
        storageState,
      });
      await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: /board (controls|settings)|보드 (컨트롤|설정)/i })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
            document.body.scrollWidth <= document.body.clientWidth,
        ),
        true,
      );
      const buttons = page.locator('[data-page-bottom-navigation] button');
      for (let index = 0; index < (await buttons.count()); index += 1) {
        const box = await buttons.nth(index).boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44);
      }
      const trigger = page.getByRole('button', {
        name: /board (controls|settings)|보드 (컨트롤|설정)/i,
      });
      await trigger.click();
      await page.getByRole('dialog').waitFor();
      assert.equal(
        await page.locator('[data-mobile-drawer-scroll-owner]').evaluate((element) => {
          const style = getComputedStyle(element);
          return style.overflowY === 'auto' || style.overflowY === 'scroll';
        }),
        true,
      );
      assert.equal(
        await page
          .locator('[data-page-scroll-owner="PAGE"]')
          .evaluate((element) => getComputedStyle(element).overflowY),
        'hidden',
      );
      await page.keyboard.press('Escape');
      await trigger.waitFor();
    } finally {
      await browser.close();
    }
  },
);
