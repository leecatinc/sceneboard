import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { chromium } from 'playwright';
import {
  compileSceneArtifactDraft,
  validateSceneArtifactTemplateDescriptor,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const recipe = JSON.parse(
  readFileSync(join(root, 'test/fixtures/kitcathub-slide-deck.json'), 'utf8'),
);
const descriptor = validateSceneArtifactTemplateDescriptor(
  JSON.parse(
    readFileSync(
      join(
        root,
        'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/artifact-templates/slide-deck.json',
      ),
      'utf8',
    ),
  ),
);
const source = compileSceneArtifactDraft(recipe, descriptor).source;
const document = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}${source.css}</style></head><body>${source.html}<script>${source.javascript}</script></body></html>`;

test('slide-deck renders and navigates at 1920×1080 and narrow viewports', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.setContent(document, { waitUntil: 'load' });

    const current = page.locator('[data-deck-current]');
    const previous = page.locator('[data-deck-previous]');
    const next = page.locator('[data-deck-next]');
    assert.equal(await current.textContent(), '1 / 7');
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isDisabled(), false);
    assert.equal(await page.locator('[data-deck-slide]:visible').count(), 1);
    assert.equal(
      await page.locator('[data-deck-slide="opening"]').getAttribute('aria-hidden'),
      'false',
    );

    await next.click();
    assert.equal(await current.textContent(), '2 / 7');
    assert.equal(await page.locator('[data-deck-slide="opening"]').isHidden(), true);
    await page.locator('[data-sb-slide-deck="v1"]').press('End');
    assert.equal(await current.textContent(), '7 / 7');
    assert.equal(await next.isDisabled(), true);
    await page.locator('[data-sb-slide-deck="v1"]').press('ArrowLeft');
    assert.equal(await current.textContent(), '6 / 7');
    assert.equal(
      await page
        .locator('[data-deck-slide]:visible')
        .evaluate((element) => getComputedStyle(element).animationName),
      'none',
    );

    const fullRect = await page.locator('[data-deck-stage]').boundingBox();
    assert.deepEqual(fullRect, { x: 0, y: 0, width: 1920, height: 1080 });

    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForFunction(() => {
      const stage = document.querySelector('[data-deck-stage]');
      return stage && stage.getBoundingClientRect().width <= 720.5;
    });
    const narrowRect = await page.locator('[data-deck-stage]').boundingBox();
    assert.ok(narrowRect.x >= -0.5);
    assert.ok(narrowRect.y >= -0.5);
    assert.ok(narrowRect.x + narrowRect.width <= 720.5);
    assert.ok(narrowRect.y + narrowRect.height <= 900.5);
    assert.equal(await page.locator('[data-deck-slide]:visible').count(), 1);
    assert.deepEqual(requests, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
