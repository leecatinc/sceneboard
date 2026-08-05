import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  type WorkerOptions,
} from 'node:worker_threads';

import { ExportFailureV1 } from './export-errors.js';
import { safeExportTitleV1 } from './export-http-response.js';
import {
  exportChromiumLaunchOptionsV1,
  exportChromiumSandboxEnabledV1,
  type ExportRenderLeaseV1,
  type ExportRenderedPageV1,
} from './export-renderer.service.js';
import {
  EXPORT_ENCODE_TIMEOUT_MS_V1,
  EXPORT_MAX_PAGES_V1,
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
} from './export-request.schema.js';

const PNG_SIGNATURE_V1 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EXPORT_CLEANUP_GRACE_MS_V1 = 1_000;
const EXPORT_ENCODED_OUTPUT_MAX_BYTES_V1 = EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 + 16_777_216;
const PDF_PAGE_MARKUP_MAX_BYTES_V1 = 96;
const PDF_DOCUMENT_OVERHEAD_MAX_BYTES_V1 = 4_096;
const PDF_HTML_MAX_BYTES_V1 =
  Math.ceil(EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 / 3) * 4 +
  EXPORT_MAX_PAGES_V1 * PDF_PAGE_MARKUP_MAX_BYTES_V1 +
  PDF_DOCUMENT_OVERHEAD_MAX_BYTES_V1;

type PdfWorkerInputV1 =
  | Readonly<{
      kind: 'html';
      pages: readonly Uint8Array[];
      title: string;
      widthMm: number;
      heightMm: number;
    }>
  | Readonly<{ kind: 'canonicalize'; bytes: Uint8Array; generatedAt: string }>;

type PdfWorkerResultV1 =
  | Readonly<{ ok: true; kind: 'html'; html: string }>
  | Readonly<{ ok: true; kind: 'canonicalize'; bytes: Uint8Array }>
  | Readonly<{ ok: false; code: 'EXPORT_BOUNDS_EXCEEDED' | 'EXPORT_ENCODE_FAILED' }>;

type PdfWorkerV1 = Pick<Worker, 'once' | 'off' | 'postMessage' | 'terminate'>;

const TRANSFER_COPY_CHUNK_BYTES_V1 = 262_144;

const reportCleanupFailure = (error: unknown): void => {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
    code: 'SCENEBOARD_EXPORT_CLEANUP_FAILED',
  });
};

const retryCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  reportCleanupFailure(lastError);
};

const settleCleanup = async (
  operations: readonly (() => void | Promise<void>)[],
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(operations.map((operation) => retryCleanup(operation))),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, EXPORT_CLEANUP_GRACE_MS_V1);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
};

const awaitEncodeOperation = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  terminateOwnedResources: () => void,
  releaseLateResult?: (value: T) => void | Promise<void>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let terminal = false;
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
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || Date.now() >= deadlineMs) fail();
    void operation.then(
      (value) => {
        if (terminal) {
          if (releaseLateResult !== undefined) void settleCleanup([() => releaseLateResult(value)]);
          return;
        }
        terminal = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (terminal) return;
        terminal = true;
        cleanup();
        reject(error);
      },
    );
  });

const assertCompletePages = (pages: readonly ExportRenderedPageV1[]): void => {
  if (pages.length === 0 || pages.length > EXPORT_MAX_PAGES_V1)
    throw new ExportFailureV1(
      pages.length > EXPORT_MAX_PAGES_V1 ? 'EXPORT_BOUNDS_EXCEEDED' : 'EXPORT_ENCODE_FAILED',
    );
  let totalBytes = 0;
  for (const [index, page] of pages.entries()) {
    totalBytes += page.png.byteLength;
    if (
      page.pageIndex !== index ||
      page.png.byteLength < PNG_SIGNATURE_V1.byteLength ||
      !page.png.subarray(0, PNG_SIGNATURE_V1.byteLength).equals(PNG_SIGNATURE_V1) ||
      page.png.byteLength > EXPORT_RENDERED_PAGE_MAX_BYTES_V1 ||
      totalBytes > EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1
    )
      throw new ExportFailureV1(
        page.png.byteLength > EXPORT_RENDERED_PAGE_MAX_BYTES_V1 ||
          totalBytes > EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1
          ? 'EXPORT_BOUNDS_EXCEEDED'
          : 'EXPORT_ENCODE_FAILED',
      );
  }
};

const pdfDate = (generatedAt: string): string => {
  const date = new Date(generatedAt);
  if (!Number.isFinite(date.getTime())) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  const part = (value: number): string => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(
    date.getUTCHours(),
  )}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}+00'00'`;
};

export const canonicalizePdfBytesV1 = (bytes: Buffer, generatedAt: string): Buffer => {
  if (bytes.byteLength > EXPORT_ENCODED_OUTPUT_MAX_BYTES_V1)
    throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii')))
    throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  const source = bytes.toString('latin1');
  const normalizedDate = pdfDate(generatedAt);
  const dateMetadata =
    source.match(/\/(?:CreationDate|ModDate)\s*\(D:[0-9]{14}[+-][0-9]{2}'[0-9]{2}'\)/gu) ?? [];
  if (
    dateMetadata.length !== 2 ||
    !dateMetadata.some((value) => value.startsWith('/CreationDate')) ||
    !dateMetadata.some((value) => value.startsWith('/ModDate'))
  )
    throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  const normalized = source
    .replace(
      /\/(CreationDate|ModDate)\s*\(D:[0-9]{14}[+-][0-9]{2}'[0-9]{2}'\)/gu,
      (_value, kind: string) => `/${kind} (${normalizedDate})`,
    )
    .replace(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/gu, (_value, a, b) => {
      return `/ID [<${'0'.repeat(String(a).length)}><${'0'.repeat(String(b).length)}>]`;
    });
  if (Buffer.byteLength(normalized, 'latin1') !== bytes.byteLength)
    throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  return Buffer.from(normalized, 'latin1');
};

const htmlDocument = (input: {
  pages: readonly Uint8Array[];
  title: string;
  widthMm: number;
  heightMm: number;
}): string => {
  if (input.pages.length === 0 || input.pages.length > EXPORT_MAX_PAGES_V1)
    throw new ExportFailureV1(
      input.pages.length > EXPORT_MAX_PAGES_V1 ? 'EXPORT_BOUNDS_EXCEEDED' : 'EXPORT_ENCODE_FAILED',
    );
  let encodedBytes = 0;
  let pageBytes = 0;
  const images: string[] = [];
  for (const png of input.pages) {
    pageBytes += png.byteLength;
    const base64Bytes = Math.ceil(png.byteLength / 3) * 4;
    encodedBytes += base64Bytes + PDF_PAGE_MARKUP_MAX_BYTES_V1;
    if (
      png.byteLength > EXPORT_RENDERED_PAGE_MAX_BYTES_V1 ||
      pageBytes > EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 ||
      encodedBytes > PDF_HTML_MAX_BYTES_V1
    )
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    if (
      png.byteLength < PNG_SIGNATURE_V1.byteLength ||
      !Buffer.from(png.buffer, png.byteOffset, PNG_SIGNATURE_V1.byteLength).equals(PNG_SIGNATURE_V1)
    )
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    images.push(
      `<section class="page"><img alt="" src="data:image/png;base64,${Buffer.from(
        png.buffer,
        png.byteOffset,
        png.byteLength,
      ).toString('base64')}"></section>`,
    );
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${safeExportTitleV1(
    input.title,
  )}</title><style>@page{size:${input.widthMm}mm ${input.heightMm}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}.page{width:${input.widthMm}mm;height:${input.heightMm}mm;margin:0;break-after:page;overflow:hidden}.page:last-child{break-after:auto}.page img{display:block;width:100%;height:100%;object-fit:fill}</style></head><body>${images.join('')}</body></html>`;
  if (html.length > PDF_HTML_MAX_BYTES_V1) throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
  return html;
};

const workerEntryPointV1 = (): URL => {
  const moduleUrl = new URL(import.meta.url);
  if (!/\.[cm]?ts$/u.test(moduleUrl.pathname)) return moduleUrl;
  const bootstrap = `import { tsImport } from ${JSON.stringify(
    import.meta.resolve('tsx/esm/api'),
  )}; await tsImport(${JSON.stringify(moduleUrl.href)}, import.meta.url);`;
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
};

const createPdfWorkerV1 = (): PdfWorkerV1 =>
  new Worker(workerEntryPointV1(), {
    workerData: { sceneboardPdfWorkerV1: true },
  } satisfies WorkerOptions);

const copyForTransferV1 = async (
  source: Uint8Array,
  isCancelled: () => boolean,
): Promise<Readonly<{ bytes: Uint8Array<ArrayBuffer>; buffer: ArrayBuffer }> | null> => {
  const buffer = new ArrayBuffer(source.byteLength);
  const output = new Uint8Array(buffer);
  for (let offset = 0; offset < source.byteLength; offset += TRANSFER_COPY_CHUNK_BYTES_V1) {
    if (isCancelled()) return null;
    const end = Math.min(source.byteLength, offset + TRANSFER_COPY_CHUNK_BYTES_V1);
    output.set(source.subarray(offset, end), offset);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return isCancelled() ? null : { bytes: output, buffer };
};

const preparePdfWorkerInputV1 = async (
  input: PdfWorkerInputV1,
  isCancelled: () => boolean,
): Promise<Readonly<{ input: PdfWorkerInputV1; transferList: readonly ArrayBuffer[] }> | null> => {
  if (input.kind === 'canonicalize') {
    const transferred = await copyForTransferV1(input.bytes, isCancelled);
    if (transferred === null) return null;
    return {
      input: { ...input, bytes: transferred.bytes },
      transferList: [transferred.buffer],
    };
  }
  const pages: Uint8Array[] = [];
  const transferList: ArrayBuffer[] = [];
  for (const page of input.pages) {
    const transferred = await copyForTransferV1(page, isCancelled);
    if (transferred === null) return null;
    pages.push(transferred.bytes);
    transferList.push(transferred.buffer);
  }
  return {
    input: { ...input, pages },
    transferList,
  };
};

const terminateWorker = (worker: PdfWorkerV1): void => {
  void Promise.resolve()
    .then(() => worker.terminate())
    .catch(reportCleanupFailure);
};

const hasExactOwnKeysV1 = (value: object, expectedKeys: readonly string[]): boolean => {
  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const parsePdfWorkerResultV1 = (value: unknown): PdfWorkerResultV1 | null => {
  if (value === null || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(result, 'ok') || typeof result.ok !== 'boolean')
    return null;
  if (!result.ok) {
    if (
      !hasExactOwnKeysV1(result, ['ok', 'code']) ||
      (result.code !== 'EXPORT_BOUNDS_EXCEEDED' && result.code !== 'EXPORT_ENCODE_FAILED')
    )
      return null;
    return { ok: false, code: result.code };
  }
  if (result.kind === 'html') {
    if (!hasExactOwnKeysV1(result, ['ok', 'kind', 'html']) || typeof result.html !== 'string')
      return null;
    return { ok: true, kind: 'html', html: result.html };
  }
  if (result.kind === 'canonicalize') {
    if (
      !hasExactOwnKeysV1(result, ['ok', 'kind', 'bytes']) ||
      !(result.bytes instanceof Uint8Array)
    )
      return null;
    return { ok: true, kind: 'canonicalize', bytes: result.bytes };
  }
  return null;
};

const runPdfWorkerV1 = (
  worker: PdfWorkerV1,
  input: PdfWorkerInputV1,
  expectedKind: 'html' | 'canonicalize',
  signal: AbortSignal,
  deadlineMs: number,
): Promise<string | Buffer> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      worker.off('message', message);
      worker.off('error', failed);
      worker.off('exit', exited);
    };
    const settleFailure = (error: unknown): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      terminateWorker(worker);
      reject(error);
    };
    const aborted = (): void => settleFailure(new ExportFailureV1('EXPORT_RENDER_TIMEOUT'));
    const message = (value: unknown): void => {
      if (terminal) return;
      const result = parsePdfWorkerResultV1(value);
      if (result === null) {
        settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED'));
        return;
      }
      if (!result.ok) {
        settleFailure(
          new ExportFailureV1(
            result.code === 'EXPORT_BOUNDS_EXCEEDED'
              ? 'EXPORT_BOUNDS_EXCEEDED'
              : 'EXPORT_ENCODE_FAILED',
          ),
        );
        return;
      }
      if (result.kind !== expectedKind) {
        settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED'));
        return;
      }
      if (result.kind === 'html') {
        if (typeof result.html !== 'string' || result.html.length > PDF_HTML_MAX_BYTES_V1) {
          settleFailure(new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED'));
          return;
        }
        terminal = true;
        cleanup();
        terminateWorker(worker);
        resolve(result.html);
        return;
      }
      if (!(result.bytes instanceof Uint8Array)) {
        settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED'));
        return;
      }
      if (result.bytes.byteLength > EXPORT_ENCODED_OUTPUT_MAX_BYTES_V1) {
        settleFailure(new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED'));
        return;
      }
      terminal = true;
      cleanup();
      terminateWorker(worker);
      resolve(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
    };
    const failed = (error: Error): void =>
      settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED', error));
    const exited = (code: number): void => {
      if (!terminal)
        settleFailure(
          new ExportFailureV1('EXPORT_ENCODE_FAILED', new Error(`PDF worker exited with ${code}`)),
        );
    };
    const timeout = setTimeout(aborted, Math.max(1, deadlineMs - Date.now()));
    worker.once('message', message);
    worker.once('error', failed);
    worker.once('exit', exited);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || Date.now() >= deadlineMs) {
      aborted();
      return;
    }
    void preparePdfWorkerInputV1(input, () => terminal)
      .then((prepared) => {
        if (terminal || prepared === null) return;
        worker.postMessage(prepared.input, prepared.transferList);
      })
      .catch((error: unknown) => {
        if (!terminal) settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED', error));
      });
  });

export class PdfExportEncoderV1 {
  constructor(
    private readonly browserRuntime: Pick<typeof chromium, 'launch'> = chromium,
    private readonly createWorker: () => PdfWorkerV1 = createPdfWorkerV1,
  ) {}

  async encode(input: {
    lease: ExportRenderLeaseV1;
    boardTitle: string;
    signal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<Buffer> {
    assertCompletePages(input.lease.pages);
    input.signal?.throwIfAborted();
    const executablePath = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    if (executablePath === undefined || executablePath === '')
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const signal = input.signal ?? new AbortController().signal;
    const deadlineMs = Math.min(
      input.deadlineMs ?? Number.POSITIVE_INFINITY,
      Date.now() + EXPORT_ENCODE_TIMEOUT_MS_V1,
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = async (): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      const ownedPage = page;
      const ownedContext = context;
      const ownedBrowser = browser;
      page = null;
      context = null;
      browser = null;
      cleanupPromise = settleCleanup([
        () => ownedPage?.close({ runBeforeUnload: false }),
        () => ownedContext?.close(),
        () => ownedBrowser?.close(),
      ]);
      await cleanupPromise;
    };
    const terminateOwnedResources = (): void => {
      void cleanup();
    };
    try {
      browser = await awaitEncodeOperation(
        this.browserRuntime.launch(
          exportChromiumLaunchOptionsV1({
            executablePath,
            chromiumSandbox: exportChromiumSandboxEnabledV1(),
            timeout: Math.max(1, deadlineMs - Date.now()),
          }),
        ),
        signal,
        deadlineMs,
        terminateOwnedResources,
        (lateBrowser) => lateBrowser.close(),
      );
      context = await awaitEncodeOperation(
        browser.newContext({
          locale: 'en-US',
          timezoneId: 'UTC',
          serviceWorkers: 'block',
          acceptDownloads: false,
        }),
        signal,
        deadlineMs,
        terminateOwnedResources,
        (lateContext) => lateContext.close(),
      );
      await awaitEncodeOperation(
        context.route('**/*', (route) => route.abort('blockedbyclient')),
        signal,
        deadlineMs,
        terminateOwnedResources,
      );
      page = await awaitEncodeOperation(
        context.newPage(),
        signal,
        deadlineMs,
        terminateOwnedResources,
        (latePage) => latePage.close({ runBeforeUnload: false }),
      );
      page.on('popup', (popup) => void settleCleanup([() => popup.close()]));
      page.on('download', (download) => void settleCleanup([() => download.cancel()]));
      const htmlInput: PdfWorkerInputV1 = {
        kind: 'html',
        pages: input.lease.pages.map((renderedPage) => renderedPage.png),
        title: input.boardTitle,
        widthMm: input.lease.projection.format.pdf.widthMm,
        heightMm: input.lease.projection.format.pdf.heightMm,
      };
      const html = await runPdfWorkerV1(this.createWorker(), htmlInput, 'html', signal, deadlineMs);
      await awaitEncodeOperation(
        page.setContent(html as string, {
          waitUntil: 'load',
          timeout: Math.max(1, deadlineMs - Date.now()),
        }),
        signal,
        deadlineMs,
        terminateOwnedResources,
      );
      await awaitEncodeOperation(
        page.evaluate(async () => document.fonts.ready),
        signal,
        deadlineMs,
        terminateOwnedResources,
      );
      input.signal?.throwIfAborted();
      const bytes = await awaitEncodeOperation(
        page.pdf({
          width: `${input.lease.projection.format.pdf.widthMm}mm`,
          height: `${input.lease.projection.format.pdf.heightMm}mm`,
          margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
          tagged: false,
          outline: false,
        }),
        signal,
        deadlineMs,
        terminateOwnedResources,
      );
      input.signal?.throwIfAborted();
      const pdfBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (pdfBytes.byteLength > EXPORT_ENCODED_OUTPUT_MAX_BYTES_V1)
        throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
      const canonicalizeInput: PdfWorkerInputV1 = {
        kind: 'canonicalize',
        bytes: pdfBytes,
        generatedAt: input.lease.generatedAt,
      };
      return (await runPdfWorkerV1(
        this.createWorker(),
        canonicalizeInput,
        'canonicalize',
        signal,
        deadlineMs,
      )) as Buffer;
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      if (input.signal?.aborted === true) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT', error);
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED', error);
    } finally {
      await cleanup();
    }
  }
}

if (
  !isMainThread &&
  workerData !== null &&
  typeof workerData === 'object' &&
  workerData.sceneboardPdfWorkerV1 === true
) {
  parentPort?.once('message', (input: PdfWorkerInputV1) => {
    void Promise.resolve()
      .then(() => {
        if (input.kind === 'html') {
          const html = htmlDocument(input);
          parentPort?.postMessage({ ok: true, kind: 'html', html } satisfies PdfWorkerResultV1);
          return;
        }
        const bytes = canonicalizePdfBytesV1(
          Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
          input.generatedAt,
        );
        const output = Uint8Array.from(bytes);
        parentPort?.postMessage(
          { ok: true, kind: 'canonicalize', bytes: output } satisfies PdfWorkerResultV1,
          [output.buffer],
        );
      })
      .catch((error: unknown) => {
        parentPort?.postMessage({
          ok: false,
          code:
            error instanceof ExportFailureV1 && error.code === 'EXPORT_BOUNDS_EXCEEDED'
              ? 'EXPORT_BOUNDS_EXCEEDED'
              : 'EXPORT_ENCODE_FAILED',
        } satisfies PdfWorkerResultV1);
      });
  });
}
