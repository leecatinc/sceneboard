import assert from 'node:assert/strict';
import test from 'node:test';
import { browserEngineName, launchBrowser } from './browser-engine';

const boardUrl = process.env.SCENEBOARD_BROWSER_BOARD_URL;
const storageState = process.env.SCENEBOARD_BROWSER_STORAGE_STATE;

test(
  '320px reader has zero document X overflow, 44px navigation, and an exclusive drawer owner',
  { skip: boardUrl === undefined || storageState === undefined },
  async () => {
    assert.ok(boardUrl);
    assert.ok(storageState);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({
        viewport: { width: 320, height: 640 },
        ...(browserEngineName === 'firefox' ? {} : { isMobile: true }),
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
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await page
        .locator('[data-mobile-drawer-slot="history"], [data-mobile-drawer-slot="connections"]')
        .first()
        .waitFor({ state: 'attached', timeout: 5_000 });
      assert.equal(await dialog.isVisible(), true, 'drawer closed during slot hydration');
      const drawerOverflow = () =>
        page.evaluate(() => {
          const element = document.querySelector('[data-mobile-drawer-scroll-owner]');
          return element === null ? null : getComputedStyle(element).overflowY;
        });
      // On a cold cache, the accessibility tree can settle before route styles do.
      // Wait for computed scroll ownership instead of dialog visibility alone.
      const drawerStyleDeadline = Date.now() + 15_000;
      let observedDrawerOverflow = await drawerOverflow();
      while (
        observedDrawerOverflow !== null &&
        !['auto', 'scroll'].includes(observedDrawerOverflow) &&
        Date.now() < drawerStyleDeadline
      ) {
        await page.waitForTimeout(50);
        observedDrawerOverflow = await drawerOverflow();
      }
      assert.notEqual(observedDrawerOverflow, null, 'drawer closed after open');
      assert.ok(
        observedDrawerOverflow !== null && ['auto', 'scroll'].includes(observedDrawerOverflow),
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
