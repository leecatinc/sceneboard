import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3440';
const contextId = (value) => value.repeat(43);
const ready = (context) => ({
  state: 'ready',
  projection: {
    shareId: 'share_public_1',
    boardId: 'board_public_1',
    revisionId: 'revision_public_1',
    publicationGeneration: 1,
    accessGeneration: 1,
    title: 'Public board',
    document: {
      schemaVersion: 2,
      defaultPageId: 'page_a',
      pages: [
        {
          pageId: 'page_a',
          title: '',
          displayMode: 'fit-page',
          scene: { protocolVersion: 1, type: 'scene', root: null },
        },
      ],
    },
    artifacts: [],
    media: [],
  },
  context: { contextId: context, validUntil: '2026-08-12T00:01:00.000Z' },
});

const buildResult = await build({
  entryPoints: [
    new URL('./fixtures/shared-board-revalidation-entry.tsx', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  plugins: [
    {
      name: 'empty-css-modules',
      setup(builder) {
        builder.onLoad({ filter: /\.css$/ }, () => ({
          contents: 'export default {};',
          loader: 'js',
        }));
      },
    },
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.NEXT_PUBLIC_BOARD_API_URL': JSON.stringify(APP_ORIGIN),
    'process.env.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN': JSON.stringify(''),
  },
});
const fixtureOutput = buildResult.outputFiles[0];
assert.ok(fixtureOutput);
const fixtureSource = new TextDecoder().decode(fixtureOutput.contents);

const documentFor = (bootstrapStates) => `<!doctype html><html><body><div id="root"></div><script>
window.process = { env: { NODE_ENV: 'production' } };
window.__sharedBoardFixture = ${JSON.stringify({ bootstrapStates }).replaceAll('<', '\\u003c')};
</script><script src="/fixture.js"></script></body></html>`;

const fulfillDocument = async (route, bootstrapStates) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/')
    return route.fulfill({ contentType: 'text/html', body: documentFor(bootstrapStates) });
  if (url.pathname === '/fixture.js')
    return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
  return false;
};

const waitForBoard = async (page, errors) => {
  await page
    .waitForFunction(
      () => window.__sharedBoardHarness?.snapshot().text.includes('Public board'),
      undefined,
      { timeout: 10_000 },
    )
    .catch(async () =>
      assert.fail(
        JSON.stringify({
          errors,
          html: await page
            .locator('body')
            .innerHTML()
            .catch(() => null),
        }),
      ),
    );
};

const unexpectedErrors = (errors, expectedStatus) =>
  errors.filter(
    (message) => !message.includes(`server responded with a status of ${expectedStatus}`),
  );

test('shared viewer retains the board across a retryable revalidation response', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  let revalidations = 0;
  await browserContext.route('**/*', async (route) => {
    if ((await fulfillDocument(route, [ready(contextId('A'))])) !== false) return;
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/public/share-contexts/')) {
      revalidations += 1;
      if (revalidations === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'Retry-After': '1' },
          body: JSON.stringify({ state: 'unavailable' }),
        });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ready(contextId('B'))),
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.clock.install();
  await page.goto(APP_ORIGIN, { waitUntil: 'load' });
  await waitForBoard(page, errors);
  await page.clock.fastForward(30_000);
  await page.waitForFunction(() =>
    window.__sharedBoardHarness?.snapshot().text.includes('Public board'),
  );
  assert.equal(revalidations, 1);
  assert.doesNotMatch(await page.locator('body').innerText(), /shared board is unavailable/iu);
  await page.clock.fastForward(1_000);
  await page.waitForFunction(() =>
    window.__sharedBoardHarness?.snapshot().text.includes('Public board'),
  );
  assert.equal(revalidations, 2);
  assert.deepEqual(await page.evaluate(() => window.__sharedBoardHarness?.snapshot()), {
    bootstrapCalls: 1,
    text: await page.locator('body').textContent(),
  });
  assert.deepEqual(unexpectedErrors(errors, 503), []);
});

test('shared viewer bootstraps into password re-entry after authorization expiry', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.route('**/*', async (route) => {
    if (
      (await fulfillDocument(route, [
        ready(contextId('A')),
        { state: 'password-required', csrfToken: 'v1.reentry' },
      ])) !== false
    )
      return;
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/public/share-contexts/'))
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ state: 'unavailable' }),
      });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.clock.install();
  await page.goto(APP_ORIGIN, { waitUntil: 'load' });
  await waitForBoard(page, errors);
  await page.clock.fastForward(30_000);
  await page.getByLabel('Password').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__sharedBoardHarness?.snapshot()), {
    bootstrapCalls: 2,
    text: await page.locator('body').textContent(),
  });
  assert.doesNotMatch(await page.locator('body').innerText(), /shared board is unavailable/iu);
  assert.deepEqual(unexpectedErrors(errors, 404), []);
});
