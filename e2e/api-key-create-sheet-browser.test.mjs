import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { extname } from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const APP_ORIGIN = 'http://127.0.0.1:3470';
const ACCOUNT_API_KEY_SCOPES_V1 = [
  'artifact:control',
  'artifact:publish',
  'board:archive',
  'board:create',
  'board:hitl:request',
  'board:hitl:respond',
  'board:media:write',
  'board:read',
  'board:write',
  'export:read',
  'history:read',
];
const screenshotDirectory = process.env.SCENEBOARD_E2E_SCREENSHOT_DIR;
const buildResult = await build({
  entryPoints: [new URL('./fixtures/api-key-create-sheet-entry.tsx', import.meta.url).pathname],
  bundle: true,
  write: false,
  outdir: 'out',
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
});
const javascript = buildResult.outputFiles.find(({ path }) => extname(path) === '.js');
const stylesheet = buildResult.outputFiles.find(({ path }) => extname(path) === '.css');
if (javascript === undefined) throw new TypeError('API-key fixture JavaScript is unavailable');
const document = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*,*::before,*::after{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;font-family:system-ui,sans-serif}
${stylesheet === undefined ? '' : new TextDecoder().decode(stylesheet.contents)}
</style></head><body><main id="root"></main><script src="/fixture.js"></script></body></html>`;

test('account API-key creation renders canonical scopes and remains usable at 320px', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
  await browserContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN && url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: document });
    if (url.origin === APP_ORIGIN && url.pathname === '/fixture.js')
      return route.fulfill({
        contentType: 'application/javascript',
        body: Buffer.from(javascript.contents),
      });
    return route.abort('blockedbyclient');
  });
  const page = await browserContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  await page.getByRole('group', { name: 'Scopes' }).waitFor();

  const scopeInputs = page.getByRole('group', { name: 'Scopes' }).getByRole('checkbox');
  assert.equal(await scopeInputs.count(), ACCOUNT_API_KEY_SCOPES_V1.length);
  assert.deepEqual(
    await scopeInputs.evaluateAll((inputs) =>
      inputs.map((input) => ({
        label: input.parentElement?.textContent?.trim(),
        checked: input.checked,
      })),
    ),
    ACCOUNT_API_KEY_SCOPES_V1.map((scope) => ({ label: scope, checked: scope === 'board:read' })),
  );

  const submit = page.getByRole('button', { name: 'Create API key' });
  await page.getByRole('button', { name: 'Deselect all' }).click();
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole('button', { name: 'Select all', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await scopeInputs.evaluateAll((inputs) => inputs.every((input) => input.checked)),
    true,
  );
  await page.getByLabel('artifact:control').focus();
  await page.keyboard.press('Space');
  await page.getByLabel('Key name (optional)').fill('Browser E2E key');
  await submit.click();
  assert.deepEqual(await page.evaluate(() => window.__apiKeyCreateHarness?.submissions()), [
    {
      displayName: 'Browser E2E key',
      scopes: ACCOUNT_API_KEY_SCOPES_V1.filter((scope) => scope !== 'artifact:control'),
      expiresInDays: 90,
    },
  ]);
  await page.evaluate(() => window.__apiKeyCreateHarness?.setBusy(true));
  assert.equal(await submit.isDisabled(), true);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.height >= 44);
  }

  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth,
    ),
    true,
  );
  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.height >= 44);
  }
  if (screenshotDirectory !== undefined) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: `${screenshotDirectory}/api-key-create-sheet-mobile.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(pageErrors, []);
});
