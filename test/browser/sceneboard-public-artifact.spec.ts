import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

const publicArtifactUrl = process.env.SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL;

test(
  'public share runs its pinned artifact package and preserves presentation mode',
  { skip: publicArtifactUrl === undefined },
  async () => {
    assert.ok(publicArtifactUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
      });
      await page.goto(publicArtifactUrl, { waitUntil: 'domcontentloaded' });
      const active = page.locator(
        '.artifact-host.artifact-active > .artifact-frame-container .artifact-runtime-frame',
      );
      await active.waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('.artifact-fallback').waitFor({ state: 'hidden', timeout: 20_000 });
      assert.equal(await page.locator('.artifact-fallback:visible').count(), 0);
      assert.equal(await page.getByText(/execution disabled|실행.*비활성/iu).count(), 0);
      const findArtifactFrame = async (): Promise<{
        frame: ReturnType<typeof page.frames>[number];
        pageCount: number;
      } | null> => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const text = await frame
            .locator('body')
            .innerText()
            .catch(() => '');
          if (text.trim() === '') continue;
          const match = text.match(/1\s*\/\s*([1-9][0-9]*)/u);
          return { frame, pageCount: Number(match?.[1] ?? 1) };
        }
        return null;
      };
      const artifactDeadline = Date.now() + 10_000;
      let artifact = await findArtifactFrame();
      while (artifact === null && Date.now() < artifactDeadline) {
        await page.waitForTimeout(100);
        artifact = await findArtifactFrame();
      }
      assert.ok(artifact);
      const { frame: artifactFrame, pageCount } = artifact;
      const sessionsLoaded = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          response.url().includes('/presentation-sessions'),
      );
      await page
        .getByRole('button', { name: /presentation|present|프리젠테이션|발표 시작/iu })
        .click();
      const livePresentation = page.getByRole('dialog', {
        name: /live presentation|실시간 발표/iu,
      });
      await livePresentation.waitFor({ state: 'visible' });
      await sessionsLoaded;
      await livePresentation
        .getByRole('button', { name: /start new presentation|새 발표 시작/iu })
        .click();
      await active.waitFor({ state: 'visible' });
      const presentationStage = page.locator('[data-presentation-active="true"]');
      await presentationStage.waitFor({ state: 'attached' });
      assert.equal(await presentationStage.count(), 1);
      const runtimeFrame = page.locator('.artifact-runtime-frame');
      await runtimeFrame.evaluate((element) => {
        element.dataset.browserSmokeIdentity = 'preserve';
      });
      const annotationToolbar = page.getByRole('toolbar', {
        name: /annotation tools|발표 주석 도구/iu,
      });
      await annotationToolbar.waitFor({ state: 'visible' });
      assert.equal(
        await annotationToolbar.evaluate((element) =>
          element.parentElement?.className.includes('annotationToolbarSlot'),
        ),
        true,
      );
      const exitPresentation = page.getByRole('button', {
        name: /exit presentation|발표 종료/iu,
      });
      const [toolbarBox, exitBox] = await Promise.all([
        annotationToolbar.boundingBox(),
        exitPresentation.boundingBox(),
      ]);
      assert.ok(toolbarBox);
      assert.ok(exitBox);
      assert.equal(
        toolbarBox.x + toolbarBox.width <= exitBox.x || exitBox.x + exitBox.width <= toolbarBox.x,
        true,
      );
      await annotationToolbar.getByRole('button', { name: /pen|펜/iu }).click();
      await annotationToolbar.locator('input[type="color"]').fill('#1264a3');
      await annotationToolbar.locator('select').selectOption('8');
      const annotationCanvas = page.locator('[data-presentation-annotation-canvas]');
      const canvasBox = await annotationCanvas.boundingBox();
      assert.ok(canvasBox);
      await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + 260, canvasBox.y + 220, { steps: 8 });
      await page.mouse.up();
      const stroke = annotationCanvas.locator('path');
      assert.equal(await stroke.count(), 1);
      assert.equal(await stroke.getAttribute('stroke'), '#1264a3');
      assert.equal(await stroke.getAttribute('stroke-width'), '8');
      for (const name of [/pointer|포인터/iu, /eraser|지우개/iu, /pen|펜/iu]) {
        await annotationToolbar.getByRole('button', { name }).click();
        assert.equal(await stroke.count(), 1);
        assert.equal(await runtimeFrame.getAttribute('data-browser-smoke-identity'), 'preserve');
      }
      await annotationToolbar.getByRole('button', { name: /undo|되돌리기/iu }).click();
      assert.equal(await stroke.count(), 0);
      await annotationToolbar.getByRole('button', { name: /redo|다시 실행/iu }).click();
      assert.equal(await stroke.count(), 1);
      await annotationToolbar.getByRole('button', { name: /pointer|포인터/iu }).click();
      const selectionDeadline = Date.now() + 5_000;
      while (
        (await artifactFrame.evaluate(
          () => getComputedStyle(document.documentElement).userSelect,
        )) !== 'none' &&
        Date.now() < selectionDeadline
      )
        await page.waitForTimeout(50);
      assert.equal(
        await artifactFrame.evaluate(() => getComputedStyle(document.documentElement).userSelect),
        'none',
      );
      if (pageCount > 1) {
        const artifactNext = artifactFrame.locator('button').last();
        await artifactNext.click();
        await artifactFrame.getByText(new RegExp(`2\\s*\\/\\s*${pageCount}`, 'u')).waitFor();
      }
      await exitPresentation.click();
      await page.locator('[data-presentation-active="false"]').waitFor({ state: 'attached' });
    } finally {
      await browser.close();
    }
  },
);
