import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3442';
const generation = 'A'.repeat(22);
const snapshot = {
  user: {
    userId: 'user_1',
    email: 'user@example.dev',
    createdAt: '2026-08-15T00:00:00.000Z',
  },
  session: {
    sessionId: 'session_1',
    idleExpiresAt: '2099-08-15T12:00:00.000Z',
    absoluteExpiresAt: '2099-08-22T12:00:00.000Z',
  },
  csrfToken: 'lcbcsrf_v1.s.binding.nonce.4100673600000.mac',
};

const buildResult = await build({
  entryPoints: [new URL('./fixtures/authenticated-route-entry.tsx', import.meta.url).pathname],
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
  },
});
const fixtureOutput = buildResult.outputFiles[0];
assert.ok(fixtureOutput);
const fixtureSource = new TextDecoder().decode(fixtureOutput.contents);

const waitForDocumentLoads = async (documentLoads, expected, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Object.entries(expected).every(([tab, count]) => documentLoads.get(tab) === count)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(Object.fromEntries(documentLoads), expected);
};

test('opening another authenticated tab does not re-enter session verification in an active tab', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const documentLoads = new Map();
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      const tab = url.searchParams.get('tab') ?? 'unknown';
      documentLoads.set(tab, (documentLoads.get(tab) ?? 0) + 1);
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    }
    if (url.pathname === '/fixture.js')
      return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
    if (url.pathname === '/api/v1/auth/session')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Auth-Generation': generation },
        body: JSON.stringify(snapshot),
      });
    return route.fulfill({ status: 204, body: '' });
  });

  const first = await browserContext.newPage();
  await first.goto(`${APP_ORIGIN}/?tab=first`, { waitUntil: 'load' });
  await first.getByText('Boards ready').waitFor();

  const second = await browserContext.newPage();
  await second.goto(`${APP_ORIGIN}/?tab=second`, { waitUntil: 'load' });
  await second.getByText('Boards ready').waitFor();
  // The second ready state confirms its session request completed; observe a
  // full quiescence window so a delayed cross-tab hint cannot false-green.
  await second.waitForTimeout(1_000);

  assert.equal(documentLoads.get('first'), 1);
  assert.equal(documentLoads.get('second'), 1);
  await browserContext.close();
});

test('a committed generation change still reloads the tab bound to the prior session', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const documentLoads = new Map();
  let sessionRequests = 0;
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      const tab = url.searchParams.get('tab') ?? 'unknown';
      documentLoads.set(tab, (documentLoads.get(tab) ?? 0) + 1);
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    }
    if (url.pathname === '/fixture.js')
      return route.fulfill({ contentType: 'application/javascript', body: fixtureSource });
    if (url.pathname === '/api/v1/auth/session') {
      sessionRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Auth-Generation': sessionRequests === 1 ? generation : 'B'.repeat(22) },
        body: JSON.stringify(snapshot),
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  const first = await browserContext.newPage();
  await first.goto(`${APP_ORIGIN}/?tab=first`, { waitUntil: 'load' });
  await first.getByText('Boards ready').waitFor();

  const second = await browserContext.newPage();
  await second.goto(`${APP_ORIGIN}/?tab=second`, { waitUntil: 'load' });
  await second.getByText('Boards ready').waitFor();
  await waitForDocumentLoads(documentLoads, { first: 2, second: 1 });

  assert.equal(documentLoads.get('first'), 2);
  assert.equal(documentLoads.get('second'), 1);
  await browserContext.close();
});
