import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { chromium } from 'playwright';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sessionId = 'S'.repeat(22);
const credential = 'C'.repeat(22);
const authorization = `SceneBoard-Export ${credential}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx3D4QAAAABJRU5ErkJggg==',
  'base64',
);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const listen = async (server, host = '127.0.0.1') => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  return `http://${host}:${address.port.toString()}`;
};

const close = async (server) => {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
};

const reservePort = async () => {
  const server = createServer();
  const origin = await listen(server);
  await close(server);
  return Number(new URL(origin).port);
};

const stopProcess = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

test(
  'internal export route applies renderer styles and locked fonts under its real CSP',
  { timeout: 120_000 },
  async (context) => {
    const chromiumExecutable =
      process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
    try {
      await access(chromiumExecutable);
    } catch {
      context.skip('the locked Chromium executable is unavailable in this workspace');
      return;
    }
    const koreanFont = await readFile(
      join(
        repositoryRoot,
        'node_modules/@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff2',
      ),
    );
    const latinFont = await readFile(
      join(
        repositoryRoot,
        'node_modules/@fontsource/noto-sans-kr/files/noto-sans-kr-latin-400-normal.woff2',
      ),
    );
    const resources = new Map([
      [sha256(koreanFont), { body: koreanFont, mediaType: 'font/woff2', subset: 'korean' }],
      [sha256(latinFont), { body: latinFont, mediaType: 'font/woff2', subset: 'latin' }],
      [sha256(png), { body: png, mediaType: 'image/png', mediaId: 'media_export' }],
    ]);
    const brokerRequests = [];
    let webOrigin = '';
    let projection = null;
    const apiServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const cors = {
        'Access-Control-Allow-Origin': webOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': '0',
        Vary: 'Origin',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      brokerRequests.push({
        path: requestUrl.pathname,
        authorization: request.headers.authorization ?? null,
        origin: request.headers.origin ?? null,
      });
      if (
        request.method !== 'GET' ||
        request.headers.authorization !== authorization ||
        request.headers.origin !== webOrigin
      ) {
        response.writeHead(404, cors);
        response.end();
        return;
      }
      if (requestUrl.pathname === `/internal/v1/export-render/${sessionId}/projection`) {
        const body = Buffer.from(JSON.stringify(projection));
        response.writeHead(200, {
          ...cors,
          'Cache-Control': 'no-store',
          'Content-Length': body.byteLength,
          'Content-Type': 'application/vnd.sceneboard.export-projection+json',
        });
        response.end(body);
        return;
      }
      const resourceMatch = requestUrl.pathname.match(
        new RegExp(`^/internal/v1/export-render/${sessionId}/resources/([a-f0-9]{64})$`, 'u'),
      );
      const resource = resourceMatch === null ? undefined : resources.get(resourceMatch[1]);
      if (resource === undefined) {
        response.writeHead(404, cors);
        response.end();
        return;
      }
      response.writeHead(200, {
        ...cors,
        'Cache-Control': 'no-store',
        'Content-Length': resource.body.byteLength,
        'Content-Type': resource.mediaType,
      });
      response.end(resource.body);
    });
    const runtimeServer = createServer((_request, response) => {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
    });
    const apiOrigin = await listen(apiServer, '127.0.0.1');
    const runtimeOrigin = await listen(runtimeServer, '127.0.0.1');
    const webPort = await reservePort();
    webOrigin = `http://127.0.0.1:${webPort.toString()}`;
    const resourceUrl = (digest) => `/internal/v1/export-render/${sessionId}/resources/${digest}`;
    projection = {
      schemaVersion: 1,
      boardId: 'AAECAwQFBgcICQoLDA0ODw',
      revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revisionNumber: 7,
      document: {
        schemaVersion: 3,
        format: 'wide_16_9',
        defaultPageId: 'page_export',
        pages: [
          {
            pageId: 'page_export',
            title: 'CSP export fixture',
            displayMode: 'fit-page',
            scene: {
              protocolVersion: 1,
              type: 'scene',
              root: {
                id: 'split_root',
                type: 'layout.split',
                direction: 'horizontal',
                gap: 12,
                children: [
                  {
                    weight: 1,
                    node: {
                      id: 'grid_root',
                      type: 'layout.grid',
                      columns: 2,
                      rows: 1,
                      gap: 8,
                      children: [
                        {
                          column: 1,
                          row: 1,
                          columnSpan: 1,
                          rowSpan: 1,
                          node: {
                            id: 'copy',
                            type: 'content.markdown',
                            markdown: 'SceneBoard 한글',
                          },
                        },
                        {
                          column: 2,
                          row: 1,
                          columnSpan: 1,
                          rowSpan: 1,
                          node: {
                            id: 'image',
                            type: 'content.image',
                            source: { type: 'media', mediaId: 'media_export' },
                            alt: 'Locked export media',
                            fit: 'contain',
                          },
                        },
                      ],
                    },
                  },
                  {
                    weight: 1,
                    node: {
                      id: 'canvas_root',
                      type: 'layout.canvas',
                      width: 400,
                      height: 300,
                      children: [
                        {
                          x: 20,
                          y: 30,
                          width: 200,
                          height: 120,
                          zIndex: 3,
                          node: {
                            id: 'canvas_split',
                            type: 'layout.split',
                            direction: 'vertical',
                            gap: 6,
                            children: [
                              {
                                weight: 2,
                                node: {
                                  id: 'canvas_copy_one',
                                  type: 'content.markdown',
                                  markdown: 'Canvas one',
                                },
                              },
                              {
                                weight: 1,
                                node: {
                                  id: 'canvas_copy_two',
                                  type: 'content.markdown',
                                  markdown: 'Canvas two',
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      format: {
        format: 'wide_16_9',
        css: { width: 1600, height: 900 },
        pdf: { widthMm: 338.67, heightMm: 190.5 },
        pptx: { widthIn: 13.333, heightIn: 7.5 },
      },
      resources: [...resources.entries()].map(([digest, resource]) => ({
        sha256: digest,
        mediaType: resource.mediaType,
        byteLength: resource.body.byteLength,
        url: resourceUrl(digest),
        usage:
          resource.mediaType === 'font/woff2'
            ? { kind: 'font', family: 'Noto Sans KR', subset: resource.subset }
            : { kind: 'media', mediaId: resource.mediaId },
      })),
    };

    const nextOutput = [];
    const nextProcess = spawn(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/next/dist/bin/next'),
        'dev',
        'sceneboard-fe',
        '--hostname',
        '127.0.0.1',
        '--port',
        webPort.toString(),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: runtimeOrigin,
          NEXT_PUBLIC_BOARD_API_URL: apiOrigin,
          SCENEBOARD_EXPORT_API_ORIGIN: apiOrigin,
          SCENEBOARD_EXPORT_ARTIFACT_RUNTIME_ORIGIN: runtimeOrigin,
          SCENEBOARD_EXPORT_WEB_ORIGIN: webOrigin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    nextProcess.stdout.on('data', (chunk) => nextOutput.push(chunk.toString()));
    nextProcess.stderr.on('data', (chunk) => nextOutput.push(chunk.toString()));

    let browser;
    try {
      const documentUrl = `${webOrigin}/internal/export-render/${sessionId}`;
      const deadline = Date.now() + 90_000;
      let lastStatus = 0;
      while (Date.now() < deadline) {
        if (nextProcess.exitCode !== null)
          throw new Error(`Next exited before readiness\n${nextOutput.join('').slice(-4_000)}`);
        try {
          const response = await fetch(documentUrl, {
            headers: { Authorization: authorization },
          });
          lastStatus = response.status;
          await response.body?.cancel();
          if (response.status === 200) break;
        } catch {
          // The loop retries while the isolated Next server binds and compiles the route.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (lastStatus !== 200)
        throw new Error(
          `internal route did not become ready (status ${lastStatus.toString()})\n${nextOutput
            .join('')
            .slice(-4_000)}`,
        );

      browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        const headers = { ...request.headers() };
        delete headers.authorization;
        delete headers.forwarded;
        delete headers.origin;
        delete headers['x-forwarded-for'];
        if (url === documentUrl && request.resourceType() === 'document')
          headers.authorization = authorization;
        if (url.startsWith(`${apiOrigin}/internal/v1/export-render/${sessionId}/`)) {
          headers.authorization = authorization;
          headers.origin = webOrigin;
        }
        await route.continue({ headers });
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__exportCspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          window.__exportCspViolations.push({
            blockedURI: event.blockedURI,
            effectiveDirective: event.effectiveDirective,
            violatedDirective: event.violatedDirective,
          });
        });
      });
      const response = await page.goto(documentUrl, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.status(), 200);
      const policy = response?.headers()['content-security-policy'] ?? '';
      assert.match(policy, /style-src-elem 'self' 'nonce-([^']+)'/u);
      assert.match(policy, /style-src-attr 'unsafe-inline'/u);
      assert.match(policy, new RegExp(`connect-src ${apiOrigin.replaceAll('.', '\\.')}`, 'u'));
      assert.match(policy, new RegExp(`frame-src ${runtimeOrigin.replaceAll('.', '\\.')}`, 'u'));
      await page.waitForFunction(() => window.__SCENEBOARD_EXPORT__?.ready === true, null, {
        timeout: 30_000,
      });
      assert.equal(await page.evaluate(() => window.__SCENEBOARD_EXPORT__?.renderPage(0)), true);

      const state = await page.evaluate(() => {
        const value = (selector, property) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
          return getComputedStyle(element).getPropertyValue(property).trim();
        };
        const pageElement = document.querySelector('main[data-export-page="0"]');
        if (!(pageElement instanceof HTMLElement)) throw new Error('missing export page');
        const pageBounds = pageElement.getBoundingClientRect();
        const wrapperBounds = pageElement.parentElement?.getBoundingClientRect();
        return {
          violations: window.__exportCspViolations,
          disallowedStyleElements: [...document.querySelectorAll('style')].filter(
            (element) => element.nonce === '',
          ).length,
          duplicateFontStyles: document.querySelectorAll('style[data-export-fonts]').length,
          fontStatus: pageElement.dataset.exportFonts,
          fonts: {
            latin: document.fonts.check('400 16px "Noto Sans KR"', 'SceneBoard'),
            korean: document.fonts.check('400 16px "Noto Sans KR"', '한글'),
          },
          pageBounds: {
            x: pageBounds.x,
            y: pageBounds.y,
            width: pageBounds.width,
            height: pageBounds.height,
          },
          wrapperBounds:
            wrapperBounds === undefined
              ? null
              : {
                  x: wrapperBounds.x,
                  y: wrapperBounds.y,
                  width: wrapperBounds.width,
                  height: wrapperBounds.height,
                },
          styles: {
            viewportOverflow: value('main[data-export-page="0"]', 'overflow'),
            canvasWidth: value('.scene-canvas-stage', '--scene-canvas-width'),
            canvasHeight: value('.scene-canvas-stage', '--scene-canvas-height'),
            canvasChildLeft: value('.scene-canvas-child', 'left'),
            gridDisplay: value('.scene-grid', 'display'),
            gridGap: value('.scene-grid', 'gap'),
            splitDisplay: value('.scene-split', 'display'),
            splitGap: value('.scene-split', 'gap'),
            splitGrow: value('.scene-split-child', 'flex-grow'),
            imageAspect: value('.scene-image', '--scene-image-aspect-ratio'),
            imageFit: value('.scene-image-content', 'object-fit'),
          },
        };
      });
      assert.deepEqual(state.violations, []);
      assert.equal(state.disallowedStyleElements, 0);
      assert.equal(state.duplicateFontStyles, 0);
      assert.equal(state.fontStatus, 'ready');
      assert.deepEqual(state.fonts, { latin: true, korean: true });
      assert.deepEqual(state.pageBounds, { x: 0, y: 0, width: 1600, height: 900 });
      assert.deepEqual(state.wrapperBounds, state.pageBounds);
      assert.deepEqual(state.styles, {
        viewportOverflow: 'hidden',
        canvasWidth: '400px',
        canvasHeight: '300px',
        canvasChildLeft: '5%',
        gridDisplay: 'grid',
        gridGap: '8px',
        splitDisplay: 'flex',
        splitGap: '12px',
        splitGrow: '1',
        imageAspect: '1 / 1',
        imageFit: 'contain',
      });
      const capture = await page.locator('main[data-export-page="0"]').screenshot({
        animations: 'disabled',
        type: 'png',
      });
      assert.equal(capture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const requestedPaths = brokerRequests.map((request) => request.path);
      assert.ok(requestedPaths.includes(`/internal/v1/export-render/${sessionId}/projection`));
      for (const digest of resources.keys())
        assert.ok(
          requestedPaths.includes(`/internal/v1/export-render/${sessionId}/resources/${digest}`),
        );
      assert.equal(
        brokerRequests.every(
          (request) => request.authorization === authorization && request.origin === webOrigin,
        ),
        true,
      );
      await context.close();
    } finally {
      if (browser !== undefined) await browser.close();
      await stopProcess(nextProcess);
      await Promise.all([close(apiServer), close(runtimeServer)]);
    }
  },
);
