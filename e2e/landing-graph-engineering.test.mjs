import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const nextCli = join(repositoryRoot, 'node_modules/next/dist/bin/next');
const screenshotDirectory = process.env.SCENEBOARD_E2E_SCREENSHOT_DIR;
const emptySecurityProbe = {
  clipboardWrites: 0,
  capabilityMessages: 0,
  policyViolations: [],
};

const ephemeralPort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('ephemeral port failed');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
};

const waitForExit = (child, timeoutMs) =>
  Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);

const readLandingGraphGeometry = (page) =>
  page.locator('[data-landing-workflow-graph="v1"]').evaluate((graph) => {
    const graphBox = graph.getBoundingClientRect();
    const previewBox = graph.parentElement.getBoundingClientRect();
    const scrollArea = graph.closest('main')?.parentElement;
    const controlBoxes = [
      ...graph.querySelectorAll('[data-landing-workflow-node], [data-landing-workflow-edge]'),
    ].map((control) => {
      const box = control.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const nodes = [...graph.querySelectorAll('[data-landing-workflow-node]')].map((node) =>
      node.getBoundingClientRect(),
    );
    const edgeBoxes = [...graph.querySelectorAll('[data-landing-workflow-edge]')].map((edge) => {
      const edgeBox = edge.getBoundingClientRect();
      return {
        box: {
          left: edgeBox.left,
          right: edgeBox.right,
          top: edgeBox.top,
          bottom: edgeBox.bottom,
        },
        avoidsNodes: nodes.every(
          (nodeBox) =>
            edgeBox.right <= nodeBox.left ||
            edgeBox.left >= nodeBox.right ||
            edgeBox.bottom <= nodeBox.top ||
            edgeBox.top >= nodeBox.bottom,
        ),
      };
    });
    return {
      scrollAreaFits: scrollArea !== undefined && scrollArea.scrollWidth === scrollArea.clientWidth,
      graphFitsViewport: graphBox.left >= 0 && graphBox.right <= window.innerWidth,
      previewFitsViewport: previewBox.left >= 0 && previewBox.right <= window.innerWidth,
      controlsFit: controlBoxes.every(
        (box) => box.left >= graphBox.left && box.right <= graphBox.right,
      ),
      edgesAvoidNodes: edgeBoxes.every((edge) => edge.avoidsNodes),
      viewport: { innerWidth: window.innerWidth },
      graph: { left: graphBox.left, right: graphBox.right },
      preview: { left: previewBox.left, right: previewBox.right },
      controlBoxes,
      edgeBoxes,
    };
  });

test(
  'signed-out landing exposes a static graph preview with no clipboard authority',
  { timeout: 45_000 },
  async () => {
    const port = await ephemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const nextDeclaration = join(repositoryRoot, 'sceneboard-fe/next-env.d.ts');
    const originalNextDeclaration = await readFile(nextDeclaration);
    const child = spawn(
      process.execPath,
      [nextCli, 'dev', 'sceneboard-fe', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          NEXT_PUBLIC_BOARD_API_URL: 'http://127.0.0.1:39001',
          NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:39002',
          SCENEBOARD_NEXT_DIST_DIR: '.next-check',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    let browser;
    try {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`Next exited before readiness\n${logs.join('').slice(-4_000)}`);
        try {
          const response = await fetch(origin);
          const html = await response.text();
          if (response.status === 200 && html.includes('data-landing-workflow-hero="v1"')) {
            ready = true;
            break;
          }
        } catch {
          // 이 테스트가 소유한 서버가 바인딩되고 공개 라우트를 컴파일하는 동안에만 재시도한다.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready)
        throw new Error(`landing route did not become ready\n${logs.join('').slice(-4_000)}`);

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
      });
      await context.addInitScript(() => {
        window.__landingSecurityProbe = {
          clipboardWrites: 0,
          capabilityMessages: 0,
          policyViolations: [],
        };
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async () => {
                window.__landingSecurityProbe.clipboardWrites += 1;
              },
            },
          });
        } catch {
          if (navigator.clipboard?.writeText !== undefined) {
            navigator.clipboard.writeText = async () => {
              window.__landingSecurityProbe.clipboardWrites += 1;
            };
          }
        }
        window.addEventListener('message', (event) => {
          if (event.data?.message?.type === 'artifact.capability.request')
            window.__landingSecurityProbe.capabilityMessages += 1;
        });
        window.addEventListener('securitypolicyviolation', (event) => {
          window.__landingSecurityProbe.policyViolations.push({
            directive: event.effectiveDirective,
            blockedUri: event.blockedURI,
          });
        });
      });
      const page = await context.newPage();
      const browserErrors = [];
      const firstPartyRequestFailures = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          (!message.text().startsWith('Failed to load resource:') ||
            message.location().url.startsWith(origin))
        )
          browserErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        if (request.url().startsWith(origin) && request.resourceType() !== 'websocket')
          firstPartyRequestFailures.push(request.url());
      });
      const navigation = await page.goto(origin, { waitUntil: 'networkidle' });
      assert.notEqual(navigation, null);
      const contentSecurityPolicy = navigation.headers()['content-security-policy'];
      assert.match(contentSecurityPolicy, /default-src 'self'/u);
      const scriptSourceDirective = contentSecurityPolicy
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('script-src '));
      assert.ok(scriptSourceDirective, contentSecurityPolicy);
      assert.deepEqual(scriptSourceDirective.split(/\s+/u), [
        'script-src',
        "'self'",
        "'unsafe-inline'",
        'http://127.0.0.2:39002',
        "'unsafe-eval'",
        'https://apis.google.com',
      ]);

      assert.deepEqual(
        await page
          .locator('[data-landing-capability]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-landing-capability')),
          ),
        ['graph', 'presentation', 'hitl'],
      );
      assert.equal(await page.locator('[role="tablist"]').count(), 0);

      const graph = page.locator('[data-landing-workflow-graph="v1"]');
      assert.equal(await graph.getAttribute('data-landing-workflow-interaction'), 'static');
      assert.equal(await graph.getByRole('button').count(), 0);
      const exportedWorkflowSpec = JSON.parse(
        await page.locator('[data-landing-workflow-export] textarea').inputValue(),
      );
      assert.deepEqual(
        await graph
          .locator('[data-landing-workflow-node]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-landing-workflow-node')).sort(),
          ),
        exportedWorkflowSpec.nodes.map(({ id }) => id).sort(),
      );
      assert.deepEqual(
        await graph
          .locator('[data-landing-workflow-edge]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-landing-workflow-edge')).sort(),
          ),
        exportedWorkflowSpec.edges.map(({ id }) => id).sort(),
      );
      assert.equal(await page.locator('dialog').count(), 0, JSON.stringify({ browserErrors }));
      const review = page.locator('[data-landing-workflow-node="node_review"]');
      await review.click();
      const reviewEdge = page.locator('[data-landing-workflow-edge="edge_start_review"]');
      await reviewEdge.click();
      assert.equal(await page.locator('dialog').count(), 0, JSON.stringify({ browserErrors }));
      assert.equal(
        await graph
          .locator('[data-landing-workflow-node], [data-landing-workflow-edge]')
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                element.tagName === 'DIV' &&
                element.getAttribute('role') === null &&
                element.getAttribute('tabindex') === null &&
                element.getAttribute('aria-haspopup') === null,
            ),
          ),
        true,
      );

      await page.getByRole('button', { name: /WorkflowSpec JSON/u }).click();
      const selection = await page
        .locator('[data-landing-workflow-export] textarea')
        .evaluate((element) => ({
          active: document.activeElement === element,
          start: element.selectionStart,
          end: element.selectionEnd,
          length: element.value.length,
        }));
      assert.equal(selection.active, true);
      assert.equal(selection.start, 0);
      assert.equal(selection.end, selection.length);
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /selected/u);
      assert.deepEqual(
        await page.evaluate(() => window.__landingSecurityProbe),
        emptySecurityProbe,
      );
      const desktopGeometry = await readLandingGraphGeometry(page);
      assert.equal(desktopGeometry.scrollAreaFits, true, JSON.stringify(desktopGeometry));
      assert.equal(desktopGeometry.previewFitsViewport, true, JSON.stringify(desktopGeometry));
      assert.equal(desktopGeometry.graphFitsViewport, true, JSON.stringify(desktopGeometry));
      assert.equal(desktopGeometry.controlsFit, true, JSON.stringify(desktopGeometry));
      assert.equal(desktopGeometry.edgesAvoidNodes, true, JSON.stringify(desktopGeometry));
      if (screenshotDirectory !== undefined) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({
          path: `${screenshotDirectory}/landing-desktop.png`,
          fullPage: true,
        });
      }

      const mobile = await context.newPage();
      await mobile.setViewportSize({ width: 320, height: 568 });
      await mobile.emulateMedia({ reducedMotion: 'reduce' });
      await mobile.goto(origin, { waitUntil: 'networkidle' });
      assert.equal(
        await mobile.locator('header').evaluate((header) =>
          [...header.querySelectorAll('a, select')]
            .filter((element) => getComputedStyle(element).display !== 'none')
            .every((element) => {
              const box = element.getBoundingClientRect();
              return box.left >= 0 && box.right <= window.innerWidth;
            }),
        ),
        true,
      );
      await mobile.locator('[data-landing-workflow-node="node_start"]').scrollIntoViewIfNeeded();
      assert.equal(
        await mobile.locator('[data-landing-workflow-node="node_start"]').isVisible(),
        true,
      );
      const mobileGraphGeometry = await readLandingGraphGeometry(mobile);
      assert.equal(mobileGraphGeometry.scrollAreaFits, true, JSON.stringify(mobileGraphGeometry));
      assert.equal(
        mobileGraphGeometry.previewFitsViewport,
        true,
        JSON.stringify(mobileGraphGeometry),
      );
      assert.equal(
        mobileGraphGeometry.graphFitsViewport,
        true,
        JSON.stringify(mobileGraphGeometry),
      );
      assert.equal(mobileGraphGeometry.controlsFit, true, JSON.stringify(mobileGraphGeometry));
      assert.equal(mobileGraphGeometry.edgesAvoidNodes, true, JSON.stringify(mobileGraphGeometry));
      const lastGraphControl = mobile
        .locator('[data-landing-workflow-node], [data-landing-workflow-edge]')
        .last();
      await lastGraphControl.click();
      assert.equal(await mobile.locator('dialog').count(), 0);
      if (screenshotDirectory !== undefined)
        await mobile.screenshot({
          path: `${screenshotDirectory}/landing-mobile.png`,
          fullPage: true,
        });
      assert.deepEqual(
        await mobile.evaluate(() => window.__landingSecurityProbe),
        emptySecurityProbe,
      );
      await mobile.close();

      const tablet = await context.newPage();
      await tablet.setViewportSize({ width: 768, height: 1024 });
      await tablet.goto(origin, { waitUntil: 'networkidle' });
      await tablet.locator('[data-landing-workflow-node="node_start"]').scrollIntoViewIfNeeded();
      const tabletGeometry = await readLandingGraphGeometry(tablet);
      for (const field of [
        'scrollAreaFits',
        'previewFitsViewport',
        'graphFitsViewport',
        'controlsFit',
        'edgesAvoidNodes',
      ])
        assert.equal(tabletGeometry[field], true, JSON.stringify(tabletGeometry));
      assert.deepEqual(
        await tablet.evaluate(() => window.__landingSecurityProbe),
        emptySecurityProbe,
      );
      if (screenshotDirectory !== undefined)
        await tablet.screenshot({
          path: `${screenshotDirectory}/landing-tablet.png`,
          fullPage: true,
        });
      await tablet.close();

      const landscape = await context.newPage();
      await landscape.setViewportSize({ width: 568, height: 320 });
      await landscape.goto(origin, { waitUntil: 'networkidle' });
      await landscape.locator('[data-landing-workflow-node="node_start"]').scrollIntoViewIfNeeded();
      const landscapeGeometry = await readLandingGraphGeometry(landscape);
      assert.equal(landscapeGeometry.scrollAreaFits, true, JSON.stringify(landscapeGeometry));
      assert.equal(landscapeGeometry.previewFitsViewport, true, JSON.stringify(landscapeGeometry));
      assert.equal(landscapeGeometry.graphFitsViewport, true, JSON.stringify(landscapeGeometry));
      assert.equal(landscapeGeometry.controlsFit, true, JSON.stringify(landscapeGeometry));
      assert.equal(landscapeGeometry.edgesAvoidNodes, true, JSON.stringify(landscapeGeometry));
      await landscape.locator('[data-landing-workflow-export]').scrollIntoViewIfNeeded();
      assert.equal(
        await landscape.locator('[data-landing-workflow-export] textarea').isVisible(),
        true,
      );
      if (screenshotDirectory !== undefined)
        await landscape.screenshot({
          path: `${screenshotDirectory}/landing-mobile-landscape.png`,
          fullPage: true,
        });
      assert.deepEqual(
        await landscape.evaluate(() => window.__landingSecurityProbe),
        emptySecurityProbe,
      );
      await landscape.close();
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(firstPartyRequestFailures, []);
      await context.close();
    } finally {
      await browser?.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      if ((await waitForExit(child, 5_000)) === 'timeout' && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 5_000);
      }
      await writeFile(nextDeclaration, originalNextDeclaration);
      assert.deepEqual(await readFile(nextDeclaration), originalNextDeclaration);
    }
  },
);
