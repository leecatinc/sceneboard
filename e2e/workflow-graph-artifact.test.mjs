import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { compileSceneArtifactDraft } from '../../skills/sceneboard/scripts/scene-artifact-core.mjs';

const skillRoot = resolve(import.meta.dirname, '../../skills/sceneboard');
const workflowSpec = JSON.parse(
  await readFile(resolve(skillRoot, 'assets/workflow-spec-examples/conditional-hitl.json'), 'utf8'),
);
const descriptor = JSON.parse(
  await readFile(resolve(skillRoot, 'assets/artifact-templates/workflow-graph.json'), 'utf8'),
);
const draft = compileSceneArtifactDraft(
  {
    artifactRecipeVersion: 1,
    template: 'workflow-graph',
    placementKey: 'approval-workflow',
    title: 'Approval workflow',
    fallbackText: 'Inspect workflow details.',
    theme: 'dark',
    size: { width: 1280, height: 800 },
    motion: 'none',
    content: { workflowSpec, copyMode: 'manual' },
  },
  descriptor,
);
const hostDraft = compileSceneArtifactDraft(
  {
    artifactRecipeVersion: 1,
    template: 'workflow-graph',
    placementKey: 'approval-workflow-host-copy',
    title: 'Approval workflow',
    fallbackText: 'Inspect workflow details.',
    theme: 'dark',
    size: { width: 1280, height: 800 },
    motion: 'none',
    content: { workflowSpec, copyMode: 'clipboard' },
  },
  descriptor,
);

const assertSelectedFallback = async (page, message) => {
  const source = page.locator('[data-workflow-json]');
  const visibility = await source.evaluate((element) => ({
    hidden: element.hidden,
    className: element.className,
    display: getComputedStyle(element).display,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  assert.equal(await source.isVisible(), true, JSON.stringify(visibility));
  assert.deepEqual(
    await source.evaluate((element) => ({
      active: document.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
      length: element.value.length,
    })),
    {
      active: true,
      start: 0,
      end: await source.inputValue().then((value) => value.length),
      length: await source.inputValue().then((value) => value.length),
    },
  );
  assert.match(await page.locator('[data-copy-status]').textContent(), message);
};

test('workflow node and edge controls open accessible details and restore focus', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>${draft.source.css}</style>${draft.source.html}`);
  await page.addScriptTag({ content: draft.source.javascript });
  const node = page.locator('[data-workflow-open="workflow-detail-approval_route"]');
  await node.click();
  const detailPanel = page.locator('[data-detail-panel]').first();
  await detailPanel.waitFor({ state: 'visible' });
  assert.equal(await detailPanel.locator('h3').textContent(), 'Needs approval?');
  await detailPanel.locator('[data-detail-close]').click();
  assert.equal(await node.evaluate((element) => document.activeElement === element), true);
  const edge = page.locator('[data-workflow-open^="workflow-detail-approval_edge"]').first();
  await edge.focus();
  await edge.press('Enter');
  await detailPanel.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await edge.evaluate((element) => document.activeElement === element), true);
  await page.locator('[data-json-export]').first().click();
  await page.locator('[data-json-modal]').waitFor({ state: 'visible' });
  await page.locator('[data-json-select]').click();
  assert.equal(
    await page.locator('[data-workflow-json]').evaluate((element) => element.selectionEnd > 0),
    true,
  );
});

test('mobile touch drag pans both graph axes and keeps the inspector usable', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext({
    viewport: { width: 360, height: 640 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await browserContext.newPage();
  await page.setContent(`<style>${draft.source.css}</style>${draft.source.html}`);
  await page.addScriptTag({ content: draft.source.javascript });
  const scroll = page.locator('.sb-graph-scroll').first();
  await scroll.evaluate((element) => {
    element.style.height = '220px';
    element.style.minHeight = '0';
  });
  for (let index = 0; index < 10; index += 1) await page.locator('[data-zoom-in]').first().click();
  const canvas = page.locator('.sb-graph-canvas').first();
  const before = await canvas.evaluate((element) => {
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42 };
  });
  const bounds = await scroll.boundingBox();
  assert.notEqual(bounds, null);
  const session = await page.context().newCDPSession(page);
  const start = await page.evaluate((rectangle) => {
    for (let y = rectangle.y + 140; y < rectangle.y + rectangle.height - 20; y += 20)
      for (let x = rectangle.x + 160; x < rectangle.x + rectangle.width - 20; x += 20) {
        const target = document.elementFromPoint(x, y);
        if (target !== null && target.closest('button') === null) return { x, y };
      }
    throw new Error('touch pan start point was unavailable');
  }, bounds);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...start, radiusX: 4, radiusY: 4 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: start.x - 140, y: start.y - 120, radiusX: 4, radiusY: 4 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const after = await canvas.evaluate((element) => {
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42 };
  });
  assert.ok(Math.abs(after.x - before.x) > 100, JSON.stringify({ before, after }));
  assert.ok(Math.abs(after.y - before.y) > 80, JSON.stringify({ before, after }));
  await page
    .locator('[data-workflow-open="workflow-detail-approval_route"]')
    .evaluate((element) => element.click());
  assert.equal(await page.locator('[data-detail-panel]').first().isVisible(), true);
  await page
    .locator('[data-sheet-handle]')
    .first()
    .evaluate((element) => element.click());
  assert.equal(await page.locator('[data-detail-panel]').first().isHidden(), true);
  await browserContext.close();
});

test('invalid hidden-node measurements preserve geometry and tab resume repairs stale SVG coordinates', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>${draft.source.css}</style>${draft.source.html}`);
  await page.addScriptTag({ content: draft.source.javascript });
  const readGeometry = () =>
    page.evaluate(() => ({
      paths: [...document.querySelectorAll('.sb-graph-path')].map((path) => path.getAttribute('d')),
      labels: [...document.querySelectorAll('[data-edge-label]')].map((label) => ({
        x: label.getAttribute('data-label-x'),
        y: label.getAttribute('data-label-y'),
        transform: label.getAttribute('transform'),
      })),
    }));
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.sb-graph-node')].every(
      (node) => node.offsetWidth > 0 && node.offsetHeight > 0,
    ),
  );
  const valid = await readGeometry();
  await page.evaluate(() => {
    document
      .querySelectorAll('.sb-graph-node')
      .forEach((node) => node.style.setProperty('display', 'none'));
    document.querySelector('[data-fit]')?.click();
  });
  assert.deepEqual(await readGeometry(), valid);
  await page.evaluate(() => {
    document
      .querySelectorAll('.sb-graph-node')
      .forEach((node) => node.style.removeProperty('display'));
    document
      .querySelectorAll('.sb-graph-path')
      .forEach((path) => path.setAttribute('d', 'M 0 0 Q 0 0 0 0'));
    document.querySelectorAll('[data-edge-label]').forEach((label) => {
      label.setAttribute('data-label-x', '0');
      label.setAttribute('data-label-y', '0');
      label.setAttribute('transform', 'translate(0 0)');
    });
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
  });
  await page.waitForFunction(
    (expected) =>
      JSON.stringify({
        paths: [...document.querySelectorAll('.sb-graph-path')].map((path) =>
          path.getAttribute('d'),
        ),
        labels: [...document.querySelectorAll('[data-edge-label]')].map((label) => ({
          x: label.getAttribute('data-label-x'),
          y: label.getAttribute('data-label-y'),
          transform: label.getAttribute('transform'),
        })),
      }) === JSON.stringify(expected),
    valid,
  );
});

test('host-copy denial, unavailable API, and timeout reveal selectable JSON', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  for (const scenario of ['unavailable', 'denied', 'timeout']) {
    const page = await browser.newPage();
    await page.setContent(`<style>${hostDraft.source.css}</style>${hostDraft.source.html}`);
    if (scenario !== 'unavailable')
      await page.evaluate((mode) => {
        const listeners = new Set();
        if (mode === 'timeout') {
          const schedule = window.setTimeout;
          window.setTimeout = (callback, _delay, ...arguments_) =>
            schedule(callback, 0, ...arguments_);
        }
        window.SceneBoardArtifact = {
          userAction() {},
          requestCapability(requestId, capability) {
            if (mode !== 'denied') return;
            queueMicrotask(() => {
              for (const listener of listeners)
                listener({
                  type: 'host.capability.result',
                  requestId,
                  capability,
                  ok: false,
                  error: { code: 'CAPABILITY_DENIED', message: 'Denied.' },
                });
            });
          },
          onHostMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          requestResize() {},
        };
      }, scenario);
    await page.addScriptTag({ content: hostDraft.source.javascript });
    await page.locator('[data-json-export]').first().click();
    await page.locator('[data-json-modal]').waitFor({ state: 'visible' });
    await page.locator('[data-copy-host]').first().click();
    await page.waitForFunction(() => {
      const source = document.querySelector('[data-workflow-json]');
      return (
        source instanceof HTMLTextAreaElement &&
        document.activeElement === source &&
        source.selectionStart === 0 &&
        source.selectionEnd === source.value.length
      );
    });
    await assertSelectedFallback(
      page,
      scenario === 'unavailable'
        ? /unavailable/u
        : scenario === 'denied'
          ? /denied or unavailable/u
          : /No clipboard result/u,
    );
    await page.close();
  }
});
