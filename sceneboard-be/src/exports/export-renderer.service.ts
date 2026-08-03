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
  ownershipSignal: AbortSignal;
  assertOwnership(): void;
  completeResponse(): Promise<void>;
  abort(): Promise<void>;
}>;

type ExportPageApiV1 = {
  ready: boolean;
  renderPage(index: number): Promise<boolean>;
};

type ExportNetworkPolicyResultV1 = ReturnType<typeof createExportNetworkPolicyV1>;

export const exportChromiumLaunchOptionsV1 = (input: { executablePath: string; timeout: number }) =>
  Object.freeze({
    headless: true,
    executablePath: input.executablePath,
    chromiumSandbox: true,
    timeout: input.timeout,
  });

const isCredentialOrForwardingHeader = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return (
    normalized === 'authorization' ||
    normalized === 'origin' ||
    normalized === 'forwarded' ||
    normalized === 'via' ||
    normalized === 'x-real-ip' ||
    normalized === 'proxy-authorization' ||
    normalized.startsWith('x-forwarded-')
  );
};

export const exportRouteHeadersV1 = (input: {
  network: ExportNetworkPolicyResultV1;
  requestUrl: string;
  resourceType: string;
  headers: Readonly<Record<string, string>>;
  token: string;
}): Record<string, string> => {
  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(([name]) => !isCredentialOrForwardingHeader(name)),
  );
  if (input.requestUrl === input.network.documentUrl && input.resourceType === 'document') {
    headers.authorization = `SceneBoard-Export ${input.token}`;
  } else if (input.network.isBrokerRequest(input.requestUrl, input.resourceType)) {
    headers.authorization = `SceneBoard-Export ${input.token}`;
    headers.origin = input.network.webOrigin;
  }
  return headers;
};

const EXPORT_CLEANUP_GRACE_MS_V1 = 1_000;

const reportCleanupFailure = (error: unknown): void => {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
    code: 'SCENEBOARD_EXPORT_CLEANUP_FAILED',
  });
};

const retryCleanup = async (operation: () => void | Promise<unknown>): Promise<boolean> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  reportCleanupFailure(lastError);
  return false;
};

const settleCleanup = async (
  operations: readonly (() => void | Promise<unknown>)[],
): Promise<void> => {
  if (operations.length === 0) return;
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(operations.map((operation) => retryCleanup(operation))),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, EXPORT_CLEANUP_GRACE_MS_V1);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
};

const cleanupRetryDelay = (): Promise<void> =>
  new Promise((resolve) => {
    const timeout = setTimeout(resolve, EXPORT_CLEANUP_GRACE_MS_V1);
    timeout.unref();
  });

const retryOwnedCleanupUntilTerminal = async (
  operation: () => void | Promise<unknown>,
): Promise<void> => {
  let attempts = 0;
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      attempts += 1;
      if (attempts % 2 === 0) {
        reportCleanupFailure(error);
        await cleanupRetryDelay();
      }
    }
  }
};

type RetainLateRenderOwnershipV1 = () => (lateCleanup?: () => void | Promise<unknown>) => void;

const awaitRenderOperation = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  terminateOwnedResources: () => void,
  releaseLateResult?: (value: T) => void | Promise<void>,
  retainLateOwnership?: RetainLateRenderOwnershipV1,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    const releasePotentialOwnership =
      releaseLateResult === undefined || retainLateOwnership === undefined
        ? undefined
        : retainLateOwnership();
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      terminateOwnedResources();
      reject(new ExportFailureV1('EXPORT_RENDER_TIMEOUT'));
    };
    const aborted = (): void => fail();
    const timeout = setTimeout(fail, Math.max(1, deadlineMs - Date.now()));
    timeout.unref();
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || Date.now() >= deadlineMs) fail();
    void operation.then(
      (value) => {
        if (terminal) {
          if (releaseLateResult !== undefined) {
            if (releasePotentialOwnership !== undefined)
              releasePotentialOwnership(() => releaseLateResult(value));
            else void settleCleanup([() => releaseLateResult(value)]).catch(reportCleanupFailure);
          }
          return;
        }
        terminal = true;
        cleanup();
        releasePotentialOwnership?.();
        resolve(value);
      },
      (error: unknown) => {
        releasePotentialOwnership?.();
        if (terminal) return;
        terminal = true;
        cleanup();
        reject(error);
      },
    );
  });

export class ExportRendererServiceV1 {
  private activeRenders = 0;

  constructor(
    private readonly broker: ExportRenderBrokerServiceV1,
    private readonly browserRuntime: Pick<typeof chromium, 'launch'> = chromium,
  ) {}

  async render(input: {
    credentials: ExportRenderSessionCredentialsV1;
    bundle: ExportProjectionBundleV1;
    apiOrigin: string;
    webOrigin: string;
    artifactRuntimeOrigin: string;
    signal: AbortSignal;
    deadlineMs: number;
    renewHold: () => Promise<void>;
    releaseHold: () => Promise<void>;
    acceptOwnership?: () => void;
    releaseFailedOwnership?: () => Promise<void>;
  }): Promise<ExportRenderLeaseV1> {
    const executablePath = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    if (executablePath === undefined || executablePath === '')
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    if (this.activeRenders >= 2) throw new ExportFailureV1('EXPORT_RATE_LIMITED');
    this.activeRenders += 1;
    try {
      input.acceptOwnership?.();
    } catch (error) {
      this.activeRenders -= 1;
      throw error;
    }
    const deadline = Math.min(input.deadlineMs, Date.now() + EXPORT_TOTAL_TIMEOUT_MS_V1);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let holdHeartbeat: NodeJS.Timeout | null = null;
    let holdRenewalFailed = false;
    let brokerRenewalFailed = false;
    let cleanupStarted = false;
    let resourceCleanupTerminal = false;
    let pendingCleanupOperations = 0;
    let pendingLateAcquisitions = 0;
    let resolveResourceCleanupTerminal: (() => void) | undefined;
    const resourceCleanupTerminalPromise = new Promise<void>((resolve) => {
      resolveResourceCleanupTerminal = resolve;
    });
    let holdReleased = false;
    let holdReleaseInFlight: Promise<void> | undefined;
    let holdRenewalInFlight: Promise<void> | undefined;
    let brokerRenewalInFlight: Promise<boolean> | undefined;
    let deliveryState: 'active' | 'completed' | 'aborted' = 'active';
    let deliveryFinalization: Promise<void> | undefined;
    let rendererSlotReleased = false;
    const rendererOwnershipAbort = new AbortController();
    const operationSignal = AbortSignal.any([input.signal, rendererOwnershipAbort.signal]);
    const finishCleanupIfTerminal = (): void => {
      if (
        resourceCleanupTerminal ||
        !cleanupStarted ||
        pendingCleanupOperations !== 0 ||
        pendingLateAcquisitions !== 0
      )
        return;
      resourceCleanupTerminal = true;
      resolveResourceCleanupTerminal?.();
    };
    const addOwnedCleanup = (operation: () => void | Promise<unknown>): void => {
      pendingCleanupOperations += 1;
      void retryOwnedCleanupUntilTerminal(operation).then(() => {
        pendingCleanupOperations -= 1;
        finishCleanupIfTerminal();
      });
    };
    const retainLateOwnership: RetainLateRenderOwnershipV1 = () => {
      pendingLateAcquisitions += 1;
      let released = false;
      return (lateCleanup) => {
        if (released) return;
        released = true;
        if (lateCleanup === undefined) {
          pendingLateAcquisitions -= 1;
          finishCleanupIfTerminal();
          return;
        }
        void retryOwnedCleanupUntilTerminal(lateCleanup).then(() => {
          pendingLateAcquisitions -= 1;
          finishCleanupIfTerminal();
        });
      };
    };
    const cleanupRender = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      const ownedPage = page;
      const ownedContext = context;
      const ownedBrowser = browser;
      page = null;
      context = null;
      browser = null;
      if (ownedPage !== null) addOwnedCleanup(() => ownedPage.close({ runBeforeUnload: false }));
      if (ownedContext !== null) addOwnedCleanup(() => ownedContext.close());
      if (ownedBrowser !== null) addOwnedCleanup(() => ownedBrowser.close());
      addOwnedCleanup(async () => {
        await brokerRenewalInFlight?.catch(() => undefined);
        await this.broker.dispose(input.credentials.sessionId);
      });
      finishCleanupIfTerminal();
    };
    const waitForCleanupGrace = async (): Promise<boolean> => {
      cleanupRender();
      if (resourceCleanupTerminal) return true;
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        resourceCleanupTerminalPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(
            resolve,
            Math.min(EXPORT_CLEANUP_GRACE_MS_V1, Math.max(1, deadline - Date.now())),
          );
          timeout.unref();
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      return resourceCleanupTerminal;
    };
    const stopHoldRenewalHeartbeat = (): void => {
      if (holdHeartbeat === null) return;
      clearInterval(holdHeartbeat);
      holdHeartbeat = null;
    };
    const finishHold = async (): Promise<void> => {
      if (holdReleased) return;
      if (holdReleaseInFlight !== undefined) return holdReleaseInFlight;
      stopHoldRenewalHeartbeat();
      await holdRenewalInFlight?.catch(() => undefined);
      const attempt = input.releaseHold().then(() => {
        holdReleased = true;
      });
      holdReleaseInFlight = attempt;
      try {
        await attempt;
      } finally {
        if (holdReleaseInFlight === attempt) holdReleaseInFlight = undefined;
      }
    };
    const releaseRendererSlot = (): void => {
      if (rendererSlotReleased) return;
      rendererSlotReleased = true;
      this.activeRenders -= 1;
    };
    const finalizeDelivery = (kind: 'complete' | 'abort'): Promise<void> => {
      if (deliveryState === 'active') deliveryState = kind === 'complete' ? 'completed' : 'aborted';
      if (deliveryFinalization !== undefined) return deliveryFinalization;
      stopHoldRenewalHeartbeat();
      cleanupRender();
      deliveryFinalization = resourceCleanupTerminalPromise.then(async () => {
        await retryOwnedCleanupUntilTerminal(finishHold);
        if (input.releaseFailedOwnership !== undefined)
          await retryOwnedCleanupUntilTerminal(input.releaseFailedOwnership);
        operationSignal.removeEventListener('abort', onAbort);
        releaseRendererSlot();
      });
      return deliveryFinalization;
    };
    const ownershipFailure = (): ExportFailureV1 => {
      if (operationSignal.reason instanceof ExportFailureV1) return operationSignal.reason;
      if (input.signal.aborted || Date.now() >= deadline)
        return new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      return new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE', operationSignal.reason);
    };
    const assertOwnership = (): void => {
      if (
        deliveryState !== 'active' ||
        operationSignal.aborted ||
        holdRenewalFailed ||
        brokerRenewalFailed
      )
        throw ownershipFailure();
    };
    const terminateOwnedResources = (): void => {
      cleanupRender();
    };
    const onAbort = (): void => {
      terminateOwnedResources();
      void finalizeDelivery('abort').catch(reportCleanupFailure);
    };
    operationSignal.addEventListener('abort', onAbort, { once: true });
    try {
      holdHeartbeat = setInterval(() => {
        if (deliveryState !== 'active' || holdRenewalInFlight !== undefined) return;
        const attempt = input.renewHold();
        holdRenewalInFlight = attempt;
        void attempt
          .catch((error: unknown) => {
            reportCleanupFailure(error);
            if (deliveryState !== 'active') return;
            holdRenewalFailed = true;
            rendererOwnershipAbort.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE', error));
          })
          .finally(() => {
            if (holdRenewalInFlight === attempt) holdRenewalInFlight = undefined;
          });
      }, EXPORT_HOLD_RENEW_SECONDS_V1 * 1_000);
      holdHeartbeat.unref();
      browser = await awaitRenderOperation(
        this.browserRuntime.launch(
          exportChromiumLaunchOptionsV1({
            executablePath,
            timeout: Math.min(EXPORT_RENDER_TIMEOUT_MS_V1, Math.max(1, deadline - Date.now())),
          }),
        ),
        operationSignal,
        deadline,
        terminateOwnedResources,
        (lateBrowser) => lateBrowser.close(),
        retainLateOwnership,
      );
      context = await awaitRenderOperation(
        browser.newContext({
          viewport: {
            width: input.bundle.projection.format.css.width,
            height: input.bundle.projection.format.css.height,
          },
          deviceScaleFactor: 2,
          locale: 'en-US',
          timezoneId: 'UTC',
          serviceWorkers: 'block',
          acceptDownloads: false,
        }),
        operationSignal,
        deadline,
        terminateOwnedResources,
        (lateContext) => lateContext.close(),
        retainLateOwnership,
      );
      const network = createExportNetworkPolicyV1({
        webOrigin: input.webOrigin,
        apiOrigin: input.apiOrigin,
        runtimeOrigin: input.artifactRuntimeOrigin,
        sessionId: input.credentials.sessionId,
      });
      await awaitRenderOperation(
        context.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          if (!network.allows(requestUrl, route.request().resourceType()))
            await route.abort('blockedbyclient');
          else {
            const headers = exportRouteHeadersV1({
              network,
              requestUrl,
              resourceType: route.request().resourceType(),
              headers: route.request().headers(),
              token: input.credentials.token,
            });
            await route.continue({ headers });
          }
        }),
        operationSignal,
        deadline,
        terminateOwnedResources,
      );
      page = await awaitRenderOperation(
        context.newPage(),
        operationSignal,
        deadline,
        terminateOwnedResources,
        (latePage) => latePage.close({ runBeforeUnload: false }),
        retainLateOwnership,
      );
      page.on(
        'popup',
        (popup) => void settleCleanup([() => popup.close()]).catch(reportCleanupFailure),
      );
      page.on(
        'download',
        (download) => void settleCleanup([() => download.cancel()]).catch(reportCleanupFailure),
      );
      heartbeat = setInterval(() => {
        if (Date.now() >= deadline || brokerRenewalInFlight !== undefined) return;
        pendingCleanupOperations += 1;
        const attempt = retryCleanup(() =>
          this.broker.renew(input.credentials.sessionId, Date.now()),
        );
        brokerRenewalInFlight = attempt;
        void attempt
          .then((renewed) => {
            if (renewed || cleanupStarted || deliveryState !== 'active') return;
            brokerRenewalFailed = true;
            rendererOwnershipAbort.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE'));
            terminateOwnedResources();
          })
          .catch(reportCleanupFailure)
          .finally(() => {
            if (brokerRenewalInFlight === attempt) brokerRenewalInFlight = undefined;
            pendingCleanupOperations -= 1;
            finishCleanupIfTerminal();
          });
      }, EXPORT_RENDER_HEARTBEAT_MS_V1);
      await awaitRenderOperation(
        page.goto(network.documentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(EXPORT_RENDER_TIMEOUT_MS_V1, Math.max(1, deadline - Date.now())),
        }),
        operationSignal,
        deadline,
        terminateOwnedResources,
      );
      await awaitRenderOperation(
        page.waitForFunction(
          () =>
            document.fonts.status === 'loaded' &&
            (window as unknown as { __SCENEBOARD_EXPORT__?: ExportPageApiV1 }).__SCENEBOARD_EXPORT__
              ?.ready === true,
          undefined,
          {
            timeout: Math.min(EXPORT_RENDER_TIMEOUT_MS_V1, Math.max(1, deadline - Date.now())),
          },
        ),
        operationSignal,
        deadline,
        terminateOwnedResources,
      );
      const pages: ExportRenderedPageV1[] = [];
      let renderedBytes = 0;
      for (let index = 0; index < input.bundle.projection.document.pages.length; index += 1) {
        if (Date.now() >= deadline || holdRenewalFailed || brokerRenewalFailed)
          throw new ExportFailureV1(
            holdRenewalFailed || brokerRenewalFailed
              ? 'EXPORT_RENDERER_UNAVAILABLE'
              : 'EXPORT_RENDER_TIMEOUT',
          );
        const ready = await awaitRenderOperation(
          page.evaluate(async (pageIndex) => {
            const api = (window as unknown as { __SCENEBOARD_EXPORT__?: ExportPageApiV1 })
              .__SCENEBOARD_EXPORT__;
            return api === undefined ? false : api.renderPage(pageIndex);
          }, index),
          operationSignal,
          deadline,
          terminateOwnedResources,
        );
        if (Date.now() >= deadline || holdRenewalFailed || brokerRenewalFailed)
          throw new ExportFailureV1(
            holdRenewalFailed || brokerRenewalFailed
              ? 'EXPORT_RENDERER_UNAVAILABLE'
              : 'EXPORT_RENDER_TIMEOUT',
          );
        if (!ready) throw new ExportFailureV1('EXPORT_REQUIRED_CONTENT_UNSUPPORTED');
        const png = await awaitRenderOperation(
          page.screenshot({
            type: 'png',
            animations: 'disabled',
            caret: 'hide',
            timeout: Math.max(1, deadline - Date.now()),
          }),
          operationSignal,
          deadline,
          terminateOwnedResources,
        );
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
      if (!(await waitForCleanupGrace())) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      return Object.freeze({
        pages: Object.freeze(pages),
        projection: input.bundle.projection,
        generatedAt: new Date(0).toISOString(),
        ownershipSignal: operationSignal,
        assertOwnership,
        completeResponse: () => finalizeDelivery('complete'),
        abort: () => finalizeDelivery('abort'),
      });
    } catch (error) {
      const resourcesTerminated = await waitForCleanupGrace();
      const finalization = finalizeDelivery('abort');
      if (resourcesTerminated) await settleCleanup([() => finalization]);
      if (holdRenewalFailed || brokerRenewalFailed)
        throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
      if (error instanceof ExportFailureV1) throw error;
      if (input.signal.aborted || Date.now() >= deadline)
        throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      if (error instanceof Error && /timeout/iu.test(error.message))
        throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE', error);
    }
  }
}
