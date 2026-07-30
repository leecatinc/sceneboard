import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { ExportFailureV1 } from './export-errors.js';
import { safeExportTitleV1 } from './export-http-response.js';
import type { ExportRenderLeaseV1, ExportRenderedPageV1 } from './export-renderer.service.js';
import {
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
} from './export-request.schema.js';

const PNG_SIGNATURE_V1 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const assertCompletePages = (pages: readonly ExportRenderedPageV1[]): void => {
  if (pages.length === 0) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
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
  pages: readonly ExportRenderedPageV1[];
  title: string;
  widthMm: number;
  heightMm: number;
}): string => {
  const images = input.pages
    .map(
      ({ png }) =>
        `<section class="page"><img alt="" src="data:image/png;base64,${png.toString(
          'base64',
        )}"></section>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeExportTitleV1(
    input.title,
  )}</title><style>@page{size:${input.widthMm}mm ${input.heightMm}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}.page{width:${input.widthMm}mm;height:${input.heightMm}mm;margin:0;break-after:page;overflow:hidden}.page:last-child{break-after:auto}.page img{display:block;width:100%;height:100%;object-fit:fill}</style></head><body>${images}</body></html>`;
};

export class PdfExportEncoderV1 {
  async encode(input: {
    lease: ExportRenderLeaseV1;
    boardTitle: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    assertCompletePages(input.lease.pages);
    input.signal?.throwIfAborted();
    const executablePath = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    if (executablePath === undefined || executablePath === '')
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    try {
      browser = await chromium.launch({ executablePath, headless: true });
      context = await browser.newContext({
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      page = await context.newPage();
      page.on('popup', (popup) => void popup.close());
      page.on('download', (download) => void download.cancel());
      await page.setContent(
        htmlDocument({
          pages: input.lease.pages,
          title: input.boardTitle,
          widthMm: input.lease.projection.format.pdf.widthMm,
          heightMm: input.lease.projection.format.pdf.heightMm,
        }),
        { waitUntil: 'load' },
      );
      await page.evaluate(async () => document.fonts.ready);
      input.signal?.throwIfAborted();
      const bytes = await page.pdf({
        width: `${input.lease.projection.format.pdf.widthMm}mm`,
        height: `${input.lease.projection.format.pdf.heightMm}mm`,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        tagged: false,
        outline: false,
      });
      input.signal?.throwIfAborted();
      return canonicalizePdfBytesV1(Buffer.from(bytes), input.lease.generatedAt);
    } catch (error) {
      if (error instanceof ExportFailureV1 || input.signal?.aborted === true) throw error;
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED', error);
    } finally {
      await page?.close({ runBeforeUnload: false }).catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
