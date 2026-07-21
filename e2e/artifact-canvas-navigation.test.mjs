import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { chromium } from 'playwright';

const css = readFileSync(new URL('../sceneboard-fe/app/globals.css', import.meta.url), 'utf8');

const markup = (input) => `<!doctype html><style>${css}</style>
<div class="artifact-frame-container" data-view-mode="${input.mode}" style="width:${input.availableWidth}px;height:${input.availableHeight}px">
  <div class="artifact-runtime-stage" style="width:${input.stageWidth}px;height:${input.stageHeight}px">
    <div class="artifact-runtime-transform" style="width:${input.contentWidth}px;height:${input.contentHeight}px;transform:translate3d(${input.x}px,${input.y}px,0) scale(${input.scale})">
      <div class="artifact-runtime-frame" style="width:${input.contentWidth}px;height:${input.contentHeight}px"></div>
    </div>
  </div>
</div>`;

test(
  'fitted canvas scroll geometry exposes only rendered bounds',
  { timeout: 15_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const page = await browser.newPage();

    await page.setContent(
      markup({
        mode: 'fit-width',
        availableWidth: 600,
        availableHeight: 800,
        stageWidth: 600,
        stageHeight: 800,
        contentWidth: 1_200,
        contentHeight: 675,
        scale: 0.5,
        x: 0,
        y: 231.25,
      }),
    );
    assert.deepEqual(
      await page.locator('.artifact-frame-container').evaluate((element) => ({
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      })),
      { clientWidth: 600, clientHeight: 800, scrollWidth: 600, scrollHeight: 800 },
    );

    await page.setContent(
      markup({
        mode: 'fit-height',
        availableWidth: 900,
        availableHeight: 600,
        stageWidth: 1_200,
        stageHeight: 600,
        contentWidth: 1_200,
        contentHeight: 600,
        scale: 1,
        x: 0,
        y: 0,
      }),
    );
    assert.deepEqual(
      await page.locator('.artifact-frame-container').evaluate((element) => ({
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      })),
      { clientWidth: 900, clientHeight: 600, scrollWidth: 1_200, scrollHeight: 600 },
    );
  },
);
