import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { test } from 'node:test';

import {
  presentationFormatDescriptorV1,
  type PresentationFormatV1,
} from '@sceneboard/board-schema';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import type { ExportAdmissionServiceV1 } from '../../src/exports/export-admission.service.js';
import type { ExportAdmittedLeaseV1 } from '../../src/exports/export-admission.service.js';
import { ExportAuditServiceV1 } from '../../src/exports/export-audit.service.js';
import { ExportControllerV1 } from '../../src/exports/export.controller.js';
import {
  exportFilenameV1,
  exportSuccessHeadersV1,
  safeExportTitleV1,
} from '../../src/exports/export-http-response.js';
import {
  canonicalizePdfBytesV1,
  PdfExportEncoderV1,
} from '../../src/exports/pdf-export.encoder.js';
import {
  PptxExportEncoderV1,
  readCanonicalPptxEntriesV1,
} from '../../src/exports/pptx-export.encoder.js';
import { ExportFailureV1 } from '../../src/exports/export-errors.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx3D4QAAAABJRU5ErkJggg==',
  'base64',
);
const BOARD_ID = '123e4567-e89b-42d3-a456-426614174000';
const GENERATED_AT = '1970-01-01T00:00:00.000Z';

const leaseV1 = (counters = { complete: 0, abort: 0 }): ExportAdmittedLeaseV1 =>
  ({
    boardTitle: 'Quarterly / 계획',
    generatedAt: GENERATED_AT,
    pages: [
      { pageIndex: 0, pageId: 'page_1', png: PNG },
      { pageIndex: 1, pageId: 'page_2', png: PNG },
    ],
    projection: {
      boardId: BOARD_ID,
      revisionId: '123e4567-e89b-42d3-a456-426614174001',
      revisionNumber: 7,
      format: {
        format: 'wide_16_9',
        css: { width: 1600, height: 900 },
        pdf: { widthMm: 338.67, heightMm: 190.5 },
        pptx: { widthIn: 13.333, heightIn: 7.5 },
      },
    },
    async auditCompleted() {},
    async auditFailed() {},
    async completeResponse() {
      counters.complete += 1;
    },
    async abort() {
      counters.abort += 1;
    },
  }) as unknown as ExportAdmittedLeaseV1;

const leaseForFormatV1 = (format: PresentationFormatV1): ExportAdmittedLeaseV1 => {
  const lease = leaseV1();
  return {
    ...lease,
    projection: {
      ...lease.projection,
      format: presentationFormatDescriptorV1(format),
    },
  };
};

test('export filenames and exact binary headers remain ASCII-only and injection safe', () => {
  assert.equal(safeExportTitleV1('  발표 / Q3\r\n"x".pptx  '), 'Q3-x-.pptx');
  assert.equal(safeExportTitleV1('가나다'), 'sceneboard');
  assert.equal(safeExportTitleV1(`${'a'.repeat(100)}.`), 'a'.repeat(80));
  assert.equal(exportFilenameV1('../', 9, 'pdf'), 'sceneboard-r9.pdf');
  assert.deepEqual(
    exportSuccessHeadersV1({
      title: 'Board',
      revisionNumber: 2,
      format: 'pptx',
      byteLength: 123,
    }),
    {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="Board-r2.pptx"',
      'Content-Length': '123',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  );
});

test('delivered PDF metadata normalization removes time and document-ID variance', () => {
  const first = Buffer.from(
    "%PDF-1.7\n/CreationDate (D:20260730010101+00'00')\n/ModDate (D:20260730010101+00'00')\n/ID [<ABCDEF><123456>]\n",
    'latin1',
  );
  const second = Buffer.from(
    "%PDF-1.7\n/CreationDate (D:20260730235959+00'00')\n/ModDate (D:20260730235959+00'00')\n/ID [<654321><FEDCBA>]\n",
    'latin1',
  );
  assert.deepEqual(
    canonicalizePdfBytesV1(first, GENERATED_AT),
    canonicalizePdfBytesV1(second, GENERATED_AT),
  );
});

test('PPTX encoder delivers deterministic ordered fixed-image slides without notes', async () => {
  const encoder = new PptxExportEncoderV1();
  const lease = leaseV1();
  const first = await encoder.encode({ lease, boardTitle: lease.boardTitle });
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const second = await encoder.encode({ lease, boardTitle: lease.boardTitle });
  assert.deepEqual(first, second);
  assert.equal(first.subarray(0, 2).toString('ascii'), 'PK');
  const entries = readCanonicalPptxEntriesV1(first);
  assert.equal(
    [...entries.keys()].some((name) => name.includes('/notes')),
    false,
  );
  assert.equal(
    [...entries.keys()].filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/u.test(name)).length,
    2,
  );
  assert.equal(
    [...entries.keys()].filter((name) => /^ppt\/media\/image-[0-9]+-[0-9]+\.png$/u.test(name))
      .length,
    2,
  );
  const core = entries.get('docProps/core.xml')?.toString('utf8') ?? '';
  assert.match(core, /1970-01-01T00:00:00\.000Z/u);
  assert.match(core, /Quarterly/u);
  assert.doesNotMatch(core, /123e4567|page_1|계획/u);
  assert.equal([...entries.keys()].join('\n'), [...entries.keys()].sort().join('\n'));
});

test('PDF encoder produces byte-identical two-page physical-format output with pinned Chromium', async (t) => {
  const executable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  if (executable === undefined) {
    t.skip('SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE is not configured');
    return;
  }
  await access(executable);
  const encoder = new PdfExportEncoderV1();
  const lease = leaseV1();
  const first = await encoder.encode({ lease, boardTitle: lease.boardTitle });
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const second = await encoder.encode({ lease, boardTitle: lease.boardTitle });
  assert.deepEqual(first, second);
  const source = first.toString('latin1');
  assert.equal((source.match(/\/Type\s*\/Page\b/gu) ?? []).length, 2);
  assert.match(source, /\/MediaBox\s*\[\s*0\s+0\s+960(?:\.\d+)?\s+540(?:\.\d+)?\s*\]/u);
  assert.doesNotMatch(source, /2026|123e4567|page_1|계획/u);
});

test('PDF and PPTX preserve every frozen physical presentation format', async (t) => {
  const executable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  if (executable === undefined) {
    t.skip('SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE is not configured');
    return;
  }
  await access(executable);
  const expectedPdfPoints = {
    wide_16_9: [960, 540],
    standard_4_3: [720, 540],
    a4_portrait: [594.95996, 841.91998],
    a4_landscape: [841.91998, 594.95996],
  } as const;
  for (const format of ['wide_16_9', 'standard_4_3', 'a4_portrait', 'a4_landscape'] as const) {
    const lease = leaseForFormatV1(format);
    const descriptor = lease.projection.format;
    const pdf = await new PdfExportEncoderV1().encode({ lease, boardTitle: lease.boardTitle });
    const pdfSource = pdf.toString('latin1');
    const [widthPoints, heightPoints] = expectedPdfPoints[format];
    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/u.exec(pdfSource);
    assert(mediaBox !== null);
    assert.ok(
      Math.abs(Number(mediaBox[1]) - widthPoints) < 0.0001,
      `${format} PDF width ${mediaBox[1]} differs from ${widthPoints}`,
    );
    assert.ok(
      Math.abs(Number(mediaBox[2]) - heightPoints) < 0.0001,
      `${format} PDF height ${mediaBox[2]} differs from ${heightPoints}`,
    );

    const pptx = await new PptxExportEncoderV1().encode({
      lease,
      boardTitle: lease.boardTitle,
    });
    const presentation =
      readCanonicalPptxEntriesV1(pptx).get('ppt/presentation.xml')?.toString('utf8') ?? '';
    const slideSize = /<p:sldSz cx="([0-9]+)" cy="([0-9]+)"/u.exec(presentation);
    assert(slideSize !== null);
    assert.equal(Number(slideSize[1]), Math.round(descriptor.pptx.widthIn * 914_400));
    assert.equal(Number(slideSize[2]), Math.round(descriptor.pptx.heightIn * 914_400));
  }
});

class ResponseV1 extends EventEmitter {
  readonly values = new Map<string, string>();
  statusCode = 0;
  headersSent = false;
  body: Buffer | null = null;

  setHeader(name: string, value: string): this {
    this.values.set(name, value);
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  end(bytes: Buffer): this {
    this.headersSent = true;
    this.body = bytes;
    queueMicrotask(() => this.emit('finish'));
    return this;
  }
}

const requestV1 = (): EventEmitter & Record<PropertyKey, unknown> => {
  const request = new EventEmitter() as EventEmitter & Record<PropertyKey, unknown>;
  request.aborted = false;
  request.body = { format: 'pdf', revisionId: null };
  request.boardPrincipal = {
    kind: 'user',
    actor: { principalKind: 'user', principalId: 'user_fixture', grantId: null },
    userPk: 1n,
    sessionPk: 2n,
    familyPublicId: 'family_fixture',
    isBrowserCredential: true,
  };
  return request;
};

test('HTTP export commits exact headers only after a complete encode and completes its lease once', async () => {
  const counters = { complete: 0, abort: 0 };
  const lease = leaseV1(counters);
  const admission = {
    async admit() {
      return lease;
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      return Buffer.from('%PDF-fixture', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new ResponseV1();
  await controller.export(BOARD_ID, requestV1() as never, response as never);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body?.toString('ascii'), '%PDF-fixture');
  assert.equal(
    response.values.get('Content-Disposition'),
    'attachment; filename="Quarterly-r7.pdf"',
  );
  assert.deepEqual(counters, { complete: 1, abort: 0 });
});

test('HTTP export exposes no success bytes or headers when encoding fails and aborts once', async () => {
  const counters = { complete: 0, abort: 0 };
  const admission = {
    async admit() {
      return leaseV1(counters);
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new ResponseV1();
  await assert.rejects(
    controller.export(BOARD_ID, requestV1() as never, response as never),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
  );
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export treats a post-commit transport error as terminal cleanup, not a second artifact', async () => {
  const counters = { complete: 0, abort: 0 };
  const lease = leaseV1(counters);
  const admission = {
    async admit() {
      return lease;
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      return Buffer.from('%PDF-fixture', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  class FailedTransportResponseV1 extends ResponseV1 {
    override end(bytes: Buffer): this {
      this.headersSent = true;
      this.body = bytes;
      queueMicrotask(() => this.emit('error', new Error('fixture transport failure')));
      return this;
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new FailedTransportResponseV1();
  await controller.export(BOARD_ID, requestV1() as never, response as never);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(counters, { complete: 1, abort: 0 });
});

test('HTTP export propagates client abort and performs one failed cleanup without success headers', async () => {
  const counters = { complete: 0, abort: 0 };
  let failedReason = '';
  const lease = {
    ...leaseV1(counters),
    async auditFailed(reason: string) {
      failedReason = reason;
    },
  };
  const admission = {
    async admit() {
      return lease;
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode(input: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      input.signal?.throwIfAborted();
      return Buffer.from('unreachable');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const request = requestV1();
  const response = new ResponseV1();
  const pending = controller.export(BOARD_ID, request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  request.aborted = true;
  request.emit('aborted');
  await pending;
  assert.equal(failedReason, 'EXPORT_ENCODE_FAILED');
  assert.equal(response.headersSent, false);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('export audit writes only closed metadata and public actor context', async () => {
  const calls: unknown[] = [];
  const repository = {
    async writeMandatory(_transaction: unknown, input: unknown) {
      calls.push(input);
    },
  } as unknown as AuditRepository;
  const audit = new ExportAuditServiceV1(repository);
  const principal = (requestV1().boardPrincipal ?? null) as never;
  const connection = {} as never;
  const common = {
    principal,
    correlationId: 'correlation_fixture',
    format: 'pdf' as const,
    revisionNumber: 7,
  };
  await audit.started(connection, common);
  await audit.completed(connection, { ...common, bytes: 123 });
  await audit.failed(connection, { ...common, reason: 'EXPORT_ENCODE_FAILED' });
  assert.deepEqual(
    calls.map((value) => (value as { event: string }).event),
    ['export.started', 'export.completed', 'export.failed'],
  );
  const encoded = JSON.stringify(calls);
  assert.match(encoded, /correlation_fixture/u);
  assert.doesNotMatch(encoded, /123e4567|Quarterly|credential|password/u);
});
