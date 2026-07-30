import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { createExportNetworkPolicyV1 } from '@sceneboard/artifact-runtime/export';

import type {
  ExportProjectionBundleV1,
  ImmutableExportProjectionV1,
} from './export-projection.service.js';
import { ExportRenderBrokerServiceV1 } from './export-render-broker.service.js';
import { ExportFailureV1 } from './export-errors.js';
import {
  EXPORT_RENDER_HEARTBEAT_MS_V1,
  type ExportRenderSessionCredentialsV1,
} from './export-render-session.repository.js';
import {
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
  EXPORT_RENDER_TIMEOUT_MS_V1,
  EXPORT_TOTAL_TIMEOUT_MS_V1,
} from './export-request.schema.js';
import { EXPORT_HOLD_RENEW_SECONDS_V1 } from './export-revision-hold.repository.js';

export type ExportRenderedPageV1 = Readonly<{
  pageIndex: number;
  pageId: string;
  png: Buffer;
}>;

export type ExportRenderLeaseV1 = Readonly<{
  pages: readonly ExportRenderedPageV1[];
  projection: ImmutableExportProjectionV1;
  generatedAt: string;
  completeResponse(): Promise<void>;
  abort(): Promise<void>;
}>;

type ExportPageApiV1 = {
  ready: boolean;
  renderPage(index: number): Promise<boolean>;
};

export class ExportRendererServiceV1 {
  private activeRenders = 0;

  constructor(private readonly broker: ExportRenderBrokerServiceV1) {}

  async render(input: {
    credentials: ExportRenderSessionCredentialsV1;
    bundle: ExportProjectionBundleV1;
    apiOrigin: string;
    webOrigin: string;
    artifactRuntimeOrigin: string;
    renewHold: () => Promise<void>;
    releaseHold: () => Promise<void>;
  }): Promise<ExportRenderLeaseV1> {
    const executablePath = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    if (executablePath === undefined || executablePath === '')
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    if (this.activeRenders >= 2) throw new ExportFailureV1('EXPORT_RATE_LIMITED');
    this.activeRenders += 1;
    const deadline = Date.now() + EXPORT_TOTAL_TIMEOUT_MS_V1;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let holdHeartbeat: NodeJS.Timeout | null = null;
    let holdRenewalFailed = false;
    let renderTerminal = false;
    let holdTerminal = false;
    const cleanupRender = async (): Promise<void> => {
      if (renderTerminal) return;
      renderTerminal = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      await page?.close({ runBeforeUnload: false }).catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await this.broker.dispose(input.credentials.sessionId).catch(() => undefined);
      this.activeRenders -= 1;
    };
    const finishHold = async (): Promise<void> => {
      if (holdTerminal) return;
      holdTerminal = true;
      if (holdHeartbeat !== null) clearInterval(holdHeartbeat);
      await input.releaseHold();
    };
    try {
      holdHeartbeat = setInterval(() => {
        void input.renewHold().catch(() => {
          holdRenewalFailed = true;
        });
      }, EXPORT_HOLD_RENEW_SECONDS_V1 * 1_000);
      holdHeartbeat.unref();
      browser = await chromium.launch({ headless: true, executablePath });
      context = await browser.newContext({
        viewport: {
          width: input.bundle.projection.format.css.width,
          height: input.bundle.projection.format.css.height,
        },
        deviceScaleFactor: 2,
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      const network = createExportNetworkPolicyV1({
        webOrigin: input.webOrigin,
        apiOrigin: input.apiOrigin,
        runtimeOrigin: input.artifactRuntimeOrigin,
        sessionId: input.credentials.sessionId,
      });
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        if (!network.allows(requestUrl, route.request().resourceType()))
          await route.abort('blockedbyclient');
        else {
          const url = new URL(requestUrl);
          const headers = { ...route.request().headers() };
          delete headers.authorization;
          if (url.origin === network.apiOrigin || requestUrl === network.documentUrl)
            headers.authorization = `SceneBoard-Export ${input.credentials.token}`;
          await route.continue({ headers });
        }
      });
      page = await context.newPage();
      page.on('popup', (popup) => void popup.close());
      page.on('download', (download) => void download.cancel());
      heartbeat = setInterval(() => {
        if (Date.now() >= deadline) return;
        void this.broker.renew(input.credentials.sessionId, Date.now());
      }, EXPORT_RENDER_HEARTBEAT_MS_V1);
      await page.goto(network.documentUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(EXPORT_RENDER_TIMEOUT_MS_V1, Math.max(1, deadline - Date.now())),
      });
      await page.waitForFunction(
        () =>
          document.fonts.status === 'loaded' &&
          (window as unknown as { __SCENEBOARD_EXPORT__?: ExportPageApiV1 }).__SCENEBOARD_EXPORT__
            ?.ready === true,
        undefined,
        {
          timeout: Math.min(EXPORT_RENDER_TIMEOUT_MS_V1, Math.max(1, deadline - Date.now())),
        },
      );
      const pages: ExportRenderedPageV1[] = [];
      let renderedBytes = 0;
      for (let index = 0; index < input.bundle.projection.document.pages.length; index += 1) {
        if (Date.now() >= deadline || holdRenewalFailed)
          throw new ExportFailureV1(
            holdRenewalFailed ? 'EXPORT_RENDERER_UNAVAILABLE' : 'EXPORT_RENDER_TIMEOUT',
          );
        const ready = await page.evaluate(async (pageIndex) => {
          const api = (window as unknown as { __SCENEBOARD_EXPORT__?: ExportPageApiV1 })
            .__SCENEBOARD_EXPORT__;
          return api === undefined ? false : api.renderPage(pageIndex);
        }, index);
        if (Date.now() >= deadline || holdRenewalFailed)
          throw new ExportFailureV1(
            holdRenewalFailed ? 'EXPORT_RENDERER_UNAVAILABLE' : 'EXPORT_RENDER_TIMEOUT',
          );
        if (!ready) throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
        const png = await page.screenshot({
          type: 'png',
          animations: 'disabled',
          caret: 'hide',
          timeout: Math.max(1, deadline - Date.now()),
        });
        renderedBytes += png.byteLength;
        if (
          png.byteLength > EXPORT_RENDERED_PAGE_MAX_BYTES_V1 ||
          renderedBytes > EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1
        )
          throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
        const source = input.bundle.projection.document.pages[index];
        if (source === undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
        pages.push(Object.freeze({ pageIndex: index, pageId: source.pageId, png }));
      }
      await cleanupRender();
      return Object.freeze({
        pages: Object.freeze(pages),
        projection: input.bundle.projection,
        generatedAt: new Date(0).toISOString(),
        completeResponse: finishHold,
        abort: finishHold,
      });
    } catch (error) {
      await cleanupRender();
      await finishHold().catch(() => undefined);
      if (error instanceof ExportFailureV1) throw error;
      if (error instanceof Error && /timeout/iu.test(error.message))
        throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE', error);
    }
  }
}
