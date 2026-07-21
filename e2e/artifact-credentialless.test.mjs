import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3410';
const RUNTIME_ORIGIN = 'http://127.0.0.2:3412';
const ASSET_PATH = `/assets/outer.${'a'.repeat(64)}.js`;

const appDocument = `<!doctype html>
<html>
  <body>
    <script>
      window.addEventListener('message', (event) => {
        if (event.data?.type !== 'scene-board-runtime-ready') return;
        document.body.dataset.runtimeReady = 'true';
        document.body.dataset.messageOrigin = event.origin;
        document.body.dataset.childOrigin = event.data.origin;
        document.body.dataset.childCredentialless = String(event.data.credentialless);
        document.body.dataset.childCookie = event.data.cookie;
      });
      const frame = document.createElement('iframe');
      frame.title = 'SceneBoard isolated artifact';
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.credentialless = true;
      document.body.append(frame);
      frame.src = '${RUNTIME_ORIGIN}/runner';
    </script>
  </body>
</html>`;

const runnerDocument = `<!doctype html>
<html>
  <body>
    <script src="${ASSET_PATH}"></script>
  </body>
</html>`;

const runnerHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': `default-src 'none'; script-src ${RUNTIME_ORIGIN}; style-src ${RUNTIME_ORIGIN}; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src blob:; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${APP_ORIGIN}; sandbox allow-scripts`,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, max-age=0',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), microphone=(), payment=(), publickey-credentials-get=(), storage-access=(), usb=(), web-share=()',
};

const assetHeaders = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

test(
  'dedicated local runtime cookie host sends no credentials and remains credentialless and opaque',
  { timeout: 15_000 },
  async (context) => {
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext();
    const runtimeRequests = [];
    await browserContext.addCookies([
      {
        name: 'lcb_session',
        value: 'session-canary',
        url: APP_ORIGIN,
        httpOnly: true,
        sameSite: 'Lax',
      },
      { name: 'lcb_csrf', value: 'csrf-canary', url: APP_ORIGIN, sameSite: 'Lax' },
    ]);
    await browserContext.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === APP_ORIGIN && url.pathname === '/') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; frame-src ${RUNTIME_ORIGIN}`,
            'Referrer-Policy': 'no-referrer',
          },
          body: appDocument,
        });
        return;
      }
      if (url.origin === RUNTIME_ORIGIN) {
        runtimeRequests.push({
          path: url.pathname,
          cookie: request.headers().cookie ?? null,
          referer: request.headers().referer ?? null,
        });
        if (url.pathname === '/runner') {
          await route.fulfill({ status: 200, headers: runnerHeaders, body: runnerDocument });
          return;
        }
        if (url.pathname === ASSET_PATH) {
          await route.fulfill({
            status: 200,
            headers: assetHeaders,
            body: "document.body.dataset.assetExecuted='true';let cookie='opaque-blocked';try{cookie=document.cookie}catch{}window.parent.postMessage({type:'scene-board-runtime-ready',origin:self.origin,credentialless:window.credentialless,cookie}, '*');",
          });
          return;
        }
      }
      await route.abort('blockedbyclient');
    });

    const page = await browserContext.newPage();
    const browserFailures = [];
    page.on('requestfailed', (request) =>
      browserFailures.push({
        url: request.url(),
        error: request.failure()?.errorText ?? 'unknown',
      }),
    );
    await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'load' });
    await page
      .waitForFunction(() => document.body.dataset.runtimeReady === 'true', undefined, {
        timeout: 3_000,
      })
      .catch(async () =>
        assert.fail(
          JSON.stringify({
            runtimeRequests,
            browserFailures,
            body: await page.locator('body').evaluate((element) => element.outerHTML),
            frames: await Promise.all(
              page.frames().map(async (frame) => ({
                url: frame.url(),
                body: await frame
                  .locator('body')
                  .evaluate((element) => element.outerHTML)
                  .catch(() => null),
              })),
            ),
          }),
        ),
      );

    assert.equal(await page.evaluate(() => 'credentialless' in HTMLIFrameElement.prototype), true);
    assert.deepEqual(
      await page.locator('iframe').evaluate((frame) => ({
        sandbox: frame.getAttribute('sandbox'),
        referrerPolicy: frame.referrerPolicy,
        credentialless: frame.credentialless,
      })),
      {
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        credentialless: true,
      },
    );
    assert.equal(await page.locator('body').getAttribute('data-message-origin'), 'null');
    assert.equal(await page.locator('body').getAttribute('data-child-origin'), 'null');
    assert.equal(await page.locator('body').getAttribute('data-child-credentialless'), 'true');
    assert.equal(await page.locator('body').getAttribute('data-child-cookie'), 'opaque-blocked');
    assert.deepEqual(runtimeRequests, [
      { path: '/runner', cookie: null, referer: null },
      { path: ASSET_PATH, cookie: null, referer: null },
    ]);
    assert.deepEqual(
      (await browserContext.cookies(APP_ORIGIN))
        .map(({ name, value }) => ({ name, value }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: 'lcb_csrf', value: 'csrf-canary' },
        { name: 'lcb_session', value: 'session-canary' },
      ],
    );
  },
);
