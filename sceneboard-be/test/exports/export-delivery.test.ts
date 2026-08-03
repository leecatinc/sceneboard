import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners, once as onceEvent } from 'node:events';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  presentationFormatDescriptorV1,
  type PresentationFormatV1,
} from '@sceneboard/board-schema';
import { createExportNetworkPolicyV1 } from '@sceneboard/artifact-runtime/export';

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
  canonicalizePptxBytesV1,
  PptxExportEncoderV1,
  readCanonicalPptxEntriesV1,
} from '../../src/exports/pptx-export.encoder.js';
import { ExportFailureV1 } from '../../src/exports/export-errors.js';
import {
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
  EXPORT_TOTAL_TIMEOUT_MS_V1,
} from '../../src/exports/export-request.schema.js';
import {
  exportRouteHeadersV1,
  ExportRendererServiceV1,
} from '../../src/exports/export-renderer.service.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx3D4QAAAABJRU5ErkJggg==',
  'base64',
);
const BOARD_ID = '123e4567-e89b-42d3-a456-426614174000';
const GENERATED_AT = '1970-01-01T00:00:00.000Z';

const withoutUnhandledRejections = async (operation: () => Promise<void>): Promise<void> => {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    await operation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', handler);
  }
};

const leaseV1 = (counters = { complete: 0, abort: 0 }): ExportAdmittedLeaseV1 =>
  ({
    ownershipSignal: new AbortController().signal,
    assertOwnership() {},
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

const aggregateBoundaryLeaseV1 = (): Readonly<{
  lease: ExportAdmittedLeaseV1;
  source: Buffer;
}> => {
  const source = Buffer.alloc(EXPORT_RENDERED_PAGE_MAX_BYTES_V1);
  PNG.copy(source, 0, 0, 8);
  const pageCount =
    EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 / EXPORT_RENDERED_PAGE_MAX_BYTES_V1;
  assert.equal(Number.isInteger(pageCount), true);
  return {
    source,
    lease: {
      ...leaseV1(),
      pages: Array.from({ length: pageCount }, (_, pageIndex) => ({
        pageIndex,
        pageId: `page_${pageIndex + 1}`,
        png: source,
      })),
    } as unknown as ExportAdmittedLeaseV1,
  };
};

const observedWorkerV1 = (
  modulePath: string,
  workerData: Readonly<Record<string, true>>,
): Readonly<{ worker: Worker; exited: Promise<void> }> => {
  const worker = new Worker(new URL(modulePath, import.meta.url), { workerData });
  return {
    worker,
    exited: onceEvent(worker, 'exit').then(() => undefined),
  };
};

test('export filenames and exact binary headers remain ASCII-only and injection safe', () => {
  assert.equal(safeExportTitleV1('  발표 / Q3\r\n"x".pptx  '), 'Q3-x-.pptx');
  assert.equal(safeExportTitleV1('가나다'), 'sceneboard');
  assert.equal(safeExportTitleV1(`${'a'.repeat(100)}.`), 'a'.repeat(80));
  assert.equal(safeExportTitleV1('Roadmap..Draft'), 'Roadmap.Draft');
  assert.equal(exportFilenameV1('../', 9, 'pdf'), 'sceneboard-r9.pdf');
  assert.equal(exportFilenameV1('Roadmap..Draft', 7, 'pdf'), 'Roadmap.Draft-r7.pdf');
  assert.equal(exportFilenameV1('Roadmap..Draft', 7, 'pptx'), 'Roadmap.Draft-r7.pptx');
  for (const format of ['pdf', 'pptx'] as const)
    assert.equal(
      exportSuccessHeadersV1({
        title: 'Roadmap..Draft',
        revisionNumber: 7,
        format,
        byteLength: 123,
      })['Content-Disposition'],
      `attachment; filename="Roadmap.Draft-r7.${format}"`,
    );
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

test('PDF encoder uses the shared sandboxed production Chromium launch options', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/locked-chromium';
  let launchOptions: Record<string, unknown> | undefined;
  const encoder = new PdfExportEncoderV1({
    async launch(options: Record<string, unknown>) {
      launchOptions = options;
      throw new Error('fixture launch stop');
    },
  } as never);
  const lease = leaseV1();
  try {
    await assert.rejects(
      encoder.encode({
        lease,
        boardTitle: lease.boardTitle,
        deadlineMs: Date.now() + 5_000,
      }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
    );
    assert.ok(launchOptions !== undefined);
    assert.deepEqual(Object.keys(launchOptions).sort(), [
      'chromiumSandbox',
      'executablePath',
      'headless',
      'timeout',
    ]);
    assert.equal(launchOptions.chromiumSandbox, true);
    assert.equal(launchOptions.executablePath, '/fixture/locked-chromium');
    assert.equal(launchOptions.headless, true);
    assert.ok(Number(launchOptions.timeout) > 0);
    assert.ok(Number(launchOptions.timeout) <= 5_000);
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('PDF worker rejects malformed result variants for HTML and canonicalization phases', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const validHtml = { ok: true, kind: 'html', html: '<html />' } as const;
  const malformedByPhase = {
    html: [
      { ok: 'yes', kind: 'html', html: '<html />' },
      { ok: true, kind: 'html' },
      { ok: true, kind: 'html', html: 1 },
      { ok: true, kind: 'html', html: '<html />', extra: true },
      { ok: true, kind: 'canonicalize', bytes: Uint8Array.of(1) },
      { ok: false, code: 'EXPORT_UNKNOWN' },
      { ok: false, code: 'EXPORT_ENCODE_FAILED', extra: true },
    ],
    canonicalize: [
      { ok: 'yes', kind: 'canonicalize', bytes: Uint8Array.of(1) },
      { ok: true, kind: 'canonicalize' },
      { ok: true, kind: 'canonicalize', bytes: 'not-bytes' },
      { ok: true, kind: 'canonicalize', bytes: Uint8Array.of(1), extra: true },
      { ok: true, kind: 'html', html: '<html />' },
      { ok: false, code: 'EXPORT_UNKNOWN' },
      { ok: false, code: 'EXPORT_BOUNDS_EXCEEDED', extra: true },
    ],
  } as const;
  const page = {
    on() {},
    async setContent() {},
    async evaluate() {},
    async pdf() {
      return Buffer.from(
        "%PDF-1.7\n/CreationDate (D:20260730010101+00'00')\n/ModDate (D:20260730010101+00'00')\n/ID [<ABCDEF><123456>]\n",
        'latin1',
      );
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };
  const lease = leaseV1();

  try {
    for (const [phase, malformedResults] of Object.entries(malformedByPhase)) {
      for (const malformedResult of malformedResults) {
        let workerIndex = 0;
        const encoder = new PdfExportEncoderV1(
          {
            async launch() {
              return browser;
            },
          } as never,
          () => {
            const currentIndex = workerIndex;
            workerIndex += 1;
            const worker = new EventEmitter() as EventEmitter & {
              postMessage(): void;
              terminate(): Promise<number>;
            };
            worker.postMessage = () => {
              const result =
                phase === 'canonicalize' && currentIndex === 0 ? validHtml : malformedResult;
              queueMicrotask(() => worker.emit('message', result));
            };
            worker.terminate = async () => 1;
            return worker as never;
          },
        );
        await assert.rejects(
          encoder.encode({ lease, boardTitle: lease.boardTitle }),
          (error: unknown) =>
            error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
          `${phase}: ${JSON.stringify(malformedResult)}`,
        );
      }
    }
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
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

test('PDF and PPTX reject a rendered page above the per-page byte boundary before allocation', async () => {
  const oversized = Buffer.alloc(33_554_433);
  PNG.copy(oversized, 0, 0, 8);
  const lease = {
    ...leaseV1(),
    pages: [{ pageIndex: 0, pageId: 'page_1', png: oversized }],
  } as unknown as ExportAdmittedLeaseV1;
  for (const encoder of [new PdfExportEncoderV1(), new PptxExportEncoderV1()])
    await assert.rejects(
      encoder.encode({ lease, boardTitle: lease.boardTitle }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_BOUNDS_EXCEEDED',
    );
});

test('PPTX canonicalization rejects a declared ZIP entry above the inflate boundary', () => {
  const name = Buffer.from('oversized.bin', 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.byteLength, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(34_603_009, 24);
  central.writeUInt16LE(name.byteLength, 28);
  const centralOffset = local.byteLength + name.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength + name.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  const archive = Buffer.concat([local, name, central, name, end]);
  assert.throws(
    () => canonicalizePptxBytesV1(archive, GENERATED_AT),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_BOUNDS_EXCEEDED',
  );
});

test('PPTX worker propagates archive bounds failures through the closed error contract', async () => {
  const worker = new EventEmitter() as EventEmitter & {
    postMessage(): void;
    terminate(): Promise<number>;
  };
  worker.postMessage = () => {
    queueMicrotask(() => worker.emit('message', { ok: false, code: 'EXPORT_BOUNDS_EXCEEDED' }));
  };
  worker.terminate = async () => 1;
  const encoder = new PptxExportEncoderV1(() => worker as never);
  const lease = leaseV1();
  await assert.rejects(
    encoder.encode({ lease, boardTitle: lease.boardTitle }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_BOUNDS_EXCEEDED',
  );
});

test('renderer injects export credentials only into the exact document and broker requests', () => {
  const network = createExportNetworkPolicyV1({
    webOrigin: 'http://127.0.0.1:3410',
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.1:3412',
    sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
  });
  const ambient = {
    Authorization: 'Bearer ambient',
    Origin: 'https://attacker.example',
    Forwarded: 'for=203.0.113.1',
    'X-Forwarded-For': '203.0.113.1',
    Accept: '*/*',
  };
  const projectionUrl = `${network.apiOrigin}/internal/v1/export-render/AAAAAAAAAAAAAAAAAAAAAA/projection`;
  assert.deepEqual(
    exportRouteHeadersV1({
      network,
      requestUrl: projectionUrl,
      resourceType: 'fetch',
      headers: ambient,
      token: 'BBBBBBBBBBBBBBBBBBBBBB',
    }),
    {
      Accept: '*/*',
      authorization: 'SceneBoard-Export BBBBBBBBBBBBBBBBBBBBBB',
      origin: network.webOrigin,
    },
  );
  assert.deepEqual(
    exportRouteHeadersV1({
      network,
      requestUrl: network.documentUrl,
      resourceType: 'document',
      headers: ambient,
      token: 'BBBBBBBBBBBBBBBBBBBBBB',
    }),
    {
      Accept: '*/*',
      authorization: 'SceneBoard-Export BBBBBBBBBBBBBBBBBBBBBB',
    },
  );
  for (const request of [
    { requestUrl: network.documentUrl, resourceType: 'script' },
    { requestUrl: `${network.documentUrl}?sibling=1`, resourceType: 'document' },
    { requestUrl: `${network.runtimeOrigin}/runner`, resourceType: 'document' },
    { requestUrl: `${network.webOrigin}/_next/static/app.js`, resourceType: 'script' },
  ]) {
    assert.deepEqual(
      exportRouteHeadersV1({
        network,
        ...request,
        headers: ambient,
        token: 'BBBBBBBBBBBBBBBBBBBBBB',
      }),
      { Accept: '*/*' },
    );
  }
});

test('PPTX generation terminates its worker exactly once when the encode deadline expires', async () => {
  class NeverSettlingWorkerV1 extends EventEmitter {
    terminations = 0;

    postMessage(): void {}

    terminate(): Promise<number> {
      this.terminations += 1;
      return Promise.resolve(1);
    }
  }
  const worker = new NeverSettlingWorkerV1();
  const encoder = new PptxExportEncoderV1(() => worker as never);
  const lease = leaseV1();
  await assert.rejects(
    encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 20 }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
  );
  assert.equal(worker.terminations, 1);
  assert.equal(worker.listenerCount('message'), 0);
  assert.equal(worker.listenerCount('error'), 0);
  assert.equal(worker.listenerCount('exit'), 0);
});

test('rejected PPTX worker termination is owned without unhandled rejection', async () => {
  class RejectingTerminationWorkerV1 extends EventEmitter {
    terminations = 0;

    postMessage(): void {}

    terminate(): Promise<number> {
      this.terminations += 1;
      return Promise.reject(new Error('fixture termination failure'));
    }
  }
  const worker = new RejectingTerminationWorkerV1();
  const encoder = new PptxExportEncoderV1(() => worker as never);
  const lease = leaseV1();
  await withoutUnhandledRejections(async () => {
    await assert.rejects(
      encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 20 }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
  });
  assert.equal(worker.terminations, 1);
});

test('PDF preparation worker is terminated when base64 preparation exceeds the deadline', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  let setContentCalls = 0;
  let terminations = 0;
  const worker = new EventEmitter() as EventEmitter & {
    postMessage(): void;
    terminate(): Promise<number>;
  };
  worker.postMessage = () => {};
  worker.terminate = async () => {
    terminations += 1;
    return 1;
  };
  const page = {
    on() {},
    async setContent() {
      setContentCalls += 1;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };
  const encoder = new PdfExportEncoderV1(
    {
      async launch() {
        return browser;
      },
    } as never,
    () => worker as never,
  );
  const lease = leaseV1();
  try {
    await assert.rejects(
      encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 20 }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    assert.equal(setContentCalls, 0);
    assert.equal(terminations, 1);
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('PDF canonicalization worker is terminated when post-generation work exceeds the deadline', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const workers: Array<EventEmitter & { terminations: number; terminate(): Promise<number> }> = [];
  let workerIndex = 0;
  const createWorker = () => {
    const currentIndex = workerIndex;
    workerIndex += 1;
    const worker = new EventEmitter() as EventEmitter & {
      terminations: number;
      postMessage(): void;
      terminate(): Promise<number>;
    };
    worker.terminations = 0;
    worker.terminate = async () => {
      worker.terminations += 1;
      return 1;
    };
    worker.postMessage = () => {
      if (currentIndex === 0)
        queueMicrotask(() => worker.emit('message', { ok: true, kind: 'html', html: '<html />' }));
    };
    workers.push(worker);
    return worker as never;
  };
  const page = {
    on() {},
    async setContent() {},
    async evaluate() {},
    async pdf() {
      return Buffer.from(
        "%PDF-1.7\n/CreationDate (D:20260730010101+00'00')\n/ModDate (D:20260730010101+00'00')\n/ID [<ABCDEF><123456>]\n",
        'latin1',
      );
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };
  const encoder = new PdfExportEncoderV1(
    {
      async launch() {
        return browser;
      },
    } as never,
    createWorker,
  );
  const lease = leaseV1();
  try {
    await assert.rejects(
      encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 30 }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    assert.equal(workers.length, 2);
    assert.deepEqual(
      workers.map((worker) => worker.terminations),
      [1, 1],
    );
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('real PPTX worker handoff remains responsive and terminates at the aggregate boundary', async () => {
  const { lease, source } = aggregateBoundaryLeaseV1();
  let observed: ReturnType<typeof observedWorkerV1> | undefined;
  let terminations = 0;
  const encoder = new PptxExportEncoderV1(() => {
    observed = observedWorkerV1('../../src/exports/pptx-export.encoder.ts', {
      sceneboardPptxWorkerV1: true,
    });
    const terminate = observed.worker.terminate.bind(observed.worker);
    observed.worker.terminate = () => {
      terminations += 1;
      return terminate();
    };
    return observed.worker;
  });
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 1);
  const startedAt = Date.now();
  try {
    await withoutUnhandledRejections(async () => {
      await assert.rejects(
        encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 25 }),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      );
      if (observed === undefined) assert.fail('expected a real PPTX worker');
      await observed.exited;
    });
  } finally {
    clearInterval(heartbeat);
  }
  if (observed === undefined) assert.fail('expected a real PPTX worker');
  assert.ok(Date.now() - startedAt < 2_000);
  assert.ok(heartbeats > 0);
  assert.equal(terminations, 1);
  assert.equal(source.byteLength, EXPORT_RENDERED_PAGE_MAX_BYTES_V1);
  assert.equal(observed.worker.listenerCount('message'), 0);
  assert.equal(observed.worker.listenerCount('error'), 0);
  assert.equal(observed.worker.listenerCount('exit'), 0);
});

test('real PDF preparation worker handoff remains responsive and preserves boundary input ownership', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const { lease, source } = aggregateBoundaryLeaseV1();
  let observed: ReturnType<typeof observedWorkerV1> | undefined;
  let terminations = 0;
  let setContentCalls = 0;
  const page = {
    on() {},
    async setContent() {
      setContentCalls += 1;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };
  const encoder = new PdfExportEncoderV1(
    {
      async launch() {
        return browser;
      },
    } as never,
    () => {
      observed = observedWorkerV1('../../src/exports/pdf-export.encoder.ts', {
        sceneboardPdfWorkerV1: true,
      });
      const terminate = observed.worker.terminate.bind(observed.worker);
      observed.worker.terminate = () => {
        terminations += 1;
        return terminate();
      };
      return observed.worker;
    },
  );
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 1);
  const startedAt = Date.now();
  try {
    await withoutUnhandledRejections(async () => {
      await assert.rejects(
        encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 25 }),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      );
      if (observed === undefined) assert.fail('expected a real PDF preparation worker');
      await observed.exited;
    });
  } finally {
    clearInterval(heartbeat);
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
  if (observed === undefined) assert.fail('expected a real PDF preparation worker');
  assert.ok(Date.now() - startedAt < 2_000);
  assert.ok(heartbeats > 0);
  assert.equal(setContentCalls, 0);
  assert.equal(terminations, 1);
  assert.equal(source.byteLength, EXPORT_RENDERED_PAGE_MAX_BYTES_V1);
  assert.equal(observed.worker.listenerCount('message'), 0);
  assert.equal(observed.worker.listenerCount('error'), 0);
  assert.equal(observed.worker.listenerCount('exit'), 0);
});

test('real PDF canonicalization worker handoff is abortable without detaching the PDF buffer', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const lease = leaseV1();
  const controller = new AbortController();
  const pdfBytes = Buffer.alloc(67_108_864);
  pdfBytes.write('%PDF-1.7\n', 0, 'ascii');
  let workerIndex = 0;
  let htmlTerminations = 0;
  let canonicalizationTerminations = 0;
  let canonicalizationWorker: ReturnType<typeof observedWorkerV1> | undefined;
  let canonicalizationStartedAt = 0;
  let canonicalizationHeartbeats = 0;
  let canonicalizationHeartbeat: NodeJS.Timeout | undefined;
  const page = {
    on() {},
    async setContent() {},
    async evaluate() {},
    async pdf() {
      canonicalizationStartedAt = Date.now();
      canonicalizationHeartbeat = setInterval(() => {
        canonicalizationHeartbeats += 1;
      }, 1);
      setTimeout(() => controller.abort(), 10);
      return pdfBytes;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };
  const encoder = new PdfExportEncoderV1(
    {
      async launch() {
        return browser;
      },
    } as never,
    () => {
      const currentIndex = workerIndex;
      workerIndex += 1;
      if (currentIndex === 0) {
        const worker = new EventEmitter() as EventEmitter & {
          postMessage(): void;
          terminate(): Promise<number>;
        };
        worker.postMessage = () => {
          queueMicrotask(() =>
            worker.emit('message', { ok: true, kind: 'html', html: '<html />' }),
          );
        };
        worker.terminate = async () => {
          htmlTerminations += 1;
          return 1;
        };
        return worker as never;
      }
      canonicalizationWorker = observedWorkerV1('../../src/exports/pdf-export.encoder.ts', {
        sceneboardPdfWorkerV1: true,
      });
      const terminate = canonicalizationWorker.worker.terminate.bind(
        canonicalizationWorker.worker,
      );
      canonicalizationWorker.worker.terminate = () => {
        canonicalizationTerminations += 1;
        return terminate();
      };
      return canonicalizationWorker.worker;
    },
  );
  try {
    await withoutUnhandledRejections(async () => {
      await assert.rejects(
        encoder.encode({
          lease,
          boardTitle: lease.boardTitle,
          signal: controller.signal,
          deadlineMs: Date.now() + 5_000,
        }),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      );
      if (canonicalizationWorker === undefined)
        assert.fail('expected a real PDF canonicalization worker');
      await canonicalizationWorker.exited;
    });
  } finally {
    if (canonicalizationHeartbeat !== undefined) clearInterval(canonicalizationHeartbeat);
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
  if (canonicalizationWorker === undefined)
    assert.fail('expected a real PDF canonicalization worker');
  assert.equal(workerIndex, 2);
  assert.ok(canonicalizationStartedAt > 0);
  assert.ok(Date.now() - canonicalizationStartedAt < 2_000);
  assert.ok(canonicalizationHeartbeats > 0);
  assert.equal(htmlTerminations, 1);
  assert.equal(canonicalizationTerminations, 1);
  assert.equal(pdfBytes.byteLength, 67_108_864);
  assert.equal(canonicalizationWorker.worker.listenerCount('message'), 0);
  assert.equal(canonicalizationWorker.worker.listenerCount('error'), 0);
  assert.equal(canonicalizationWorker.worker.listenerCount('exit'), 0);
});

test('PDF deadline closes late Chromium ownership instead of leaking a launched browser', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  let resolveLaunch: ((browser: unknown) => void) | undefined;
  let browserCloseAttempts = 0;
  const launch = new Promise<unknown>((resolve) => {
    resolveLaunch = resolve;
  });
  const encoder = new PdfExportEncoderV1({
    launch: () => launch,
  } as never);
  const lease = leaseV1();
  try {
    await withoutUnhandledRejections(async () => {
      await assert.rejects(
        encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 20 }),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      );
      resolveLaunch?.({
        async close() {
          browserCloseAttempts += 1;
          if (browserCloseAttempts === 1) throw new Error('fixture browser close failure');
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(browserCloseAttempts, 2);
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('PDF generation deadline actively closes every acquired Chromium resource once', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const closes = { page: 0, context: 0, browser: 0 };
  const page = {
    on() {},
    async setContent() {},
    async evaluate() {},
    pdf: () => new Promise<never>(() => undefined),
    async close() {
      closes.page += 1;
    },
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      closes.context += 1;
    },
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      closes.browser += 1;
    },
  };
  const encoder = new PdfExportEncoderV1({
    async launch() {
      return browser;
    },
  } as never);
  const lease = leaseV1();
  try {
    await assert.rejects(
      encoder.encode({ lease, boardTitle: lease.boardTitle, deadlineMs: Date.now() + 20 }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    assert.deepEqual(closes, { page: 1, context: 1, browser: 1 });
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('renderer deadline closes page, context, browser, broker, and hold during stuck evaluation', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const closes = { page: 0, context: 0, browser: 0, broker: 0, hold: 0 };
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    evaluate: () => new Promise<never>(() => undefined),
    async screenshot() {
      return PNG;
    },
    async close() {
      closes.page += 1;
    },
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      closes.context += 1;
    },
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      closes.browser += 1;
    },
  };
  const renderer = new ExportRendererServiceV1(
    {
      async renew() {},
      async dispose() {
        closes.broker += 1;
      },
    } as never,
    {
      async launch() {
        return browser;
      },
    } as never,
  );
  try {
    await assert.rejects(
      renderer.render({
        credentials: {
          sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
          token: 'BBBBBBBBBBBBBBBBBBBBBB',
        } as never,
        bundle: {
          projection: {
            format: leaseV1().projection.format,
            document: { pages: [{ pageId: 'page_1' }] },
          },
        } as never,
        apiOrigin: 'http://127.0.0.1:3411',
        webOrigin: 'http://127.0.0.1:3000',
        artifactRuntimeOrigin: 'http://127.0.0.1:3412',
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 20,
        async renewHold() {},
        async releaseHold() {
          closes.hold += 1;
        },
      }),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    assert.deepEqual(closes, { page: 1, context: 1, browser: 1, broker: 1, hold: 1 });
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('renderer quarantines two late browsers and rejects a third render until teardown is terminal', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const launchResolvers: Array<(browser: unknown) => void> = [];
  const lateLaunches = [0, 1].map(
    () =>
      new Promise<unknown>((resolve) => {
        launchResolvers.push(resolve);
      }),
  );
  const closeResolvers: Array<() => void> = [];
  const lateBrowsers = [0, 1].map(() => ({
    async newContext() {
      throw new Error('late browser must never enter rendering');
    },
    close: () =>
      new Promise<void>((resolve) => {
        closeResolvers.push(resolve);
      }),
  }));
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate() {
      return true;
    },
    async screenshot() {
      return PNG;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  let launchIndex = 0;
  let holdReleases = 0;
  let failedOwnershipReleases = 0;
  const renderer = new ExportRendererServiceV1(
    { async renew() {}, async dispose() {} } as never,
    {
      async launch() {
        const late = lateLaunches[launchIndex];
        launchIndex += 1;
        if (late !== undefined) return late;
        return {
          async newContext() {
            return context;
          },
          async close() {},
        };
      },
    } as never,
  );
  const render = (sessionId: string, deadlineMs: number) =>
    renderer.render({
      credentials: { sessionId, token: 'BBBBBBBBBBBBBBBBBBBBBB' } as never,
      bundle: {
        projection: {
          format: leaseV1().projection.format,
          document: { pages: [{ pageId: 'page_1' }] },
        },
      } as never,
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
      signal: new AbortController().signal,
      deadlineMs,
      async renewHold() {},
      async releaseHold() {
        holdReleases += 1;
      },
      async releaseFailedOwnership() {
        failedOwnershipReleases += 1;
      },
    });
  try {
    await Promise.all([
      assert.rejects(
        render('AAAAAAAAAAAAAAAAAAAAAA', Date.now() + 20),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      ),
      assert.rejects(
        render('CCCCCCCCCCCCCCCCCCCCCC', Date.now() + 20),
        (error: unknown) =>
          error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
      ),
    ]);
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 2);
    assert.equal(holdReleases, 0);
    assert.equal(failedOwnershipReleases, 0);
    await assert.rejects(
      render('DDDDDDDDDDDDDDDDDDDDDD', Date.now() + 1_000),
      (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
    );
    launchResolvers[0]?.(lateBrowsers[0]);
    launchResolvers[1]?.(lateBrowsers[1]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 2);
    assert.equal(holdReleases, 0);
    assert.equal(failedOwnershipReleases, 0);
    closeResolvers[0]?.();
    closeResolvers[1]?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 0);
    assert.equal(holdReleases, 2);
    assert.equal(failedOwnershipReleases, 2);

    const lease = await render('DDDDDDDDDDDDDDDDDDDDDD', Date.now() + 1_000);
    await lease.abort();
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 0);
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('renderer owns rejected detached cleanup and heartbeat renewal without leaking capacity', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const attempts = {
    page: 0,
    context: 0,
    browser: 0,
    brokerDispose: 0,
    brokerRenew: 0,
    hold: 0,
    popup: 0,
    download: 0,
  };
  const handlers: Record<string, (value: unknown) => void> = {};
  const intervalCallbacks: Array<() => void> = [];
  globalThis.setInterval = ((handler: () => void) => {
    intervalCallbacks.push(handler);
    return {
      unref() {
        return this;
      },
    } as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  const page = {
    on(event: string, handler: (value: unknown) => void) {
      handlers[event] = handler;
    },
    async goto() {},
    async waitForFunction() {},
    evaluate() {
      handlers.popup?.({
        async close() {
          attempts.popup += 1;
          if (attempts.popup === 1) throw new Error('fixture popup close failure');
        },
      });
      handlers.download?.({
        async cancel() {
          attempts.download += 1;
          if (attempts.download === 1) throw new Error('fixture download cancel failure');
        },
      });
      for (const callback of intervalCallbacks.splice(0)) callback();
      return new Promise<never>(() => undefined);
    },
    async screenshot() {
      return PNG;
    },
    async close() {
      attempts.page += 1;
      if (attempts.page === 1) throw new Error('fixture page close failure');
    },
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      attempts.context += 1;
      if (attempts.context === 1) throw new Error('fixture context close failure');
    },
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      attempts.browser += 1;
      if (attempts.browser === 1) throw new Error('fixture browser close failure');
    },
  };
  const renderer = new ExportRendererServiceV1(
    {
      async renew() {
        attempts.brokerRenew += 1;
        throw new Error('fixture broker renewal failure');
      },
      async dispose() {
        attempts.brokerDispose += 1;
        if (attempts.brokerDispose === 1) throw new Error('fixture broker dispose failure');
      },
    } as never,
    {
      async launch() {
        return browser;
      },
    } as never,
  );
  try {
    await withoutUnhandledRejections(async () => {
      await assert.rejects(
        renderer.render({
          credentials: {
            sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
            token: 'BBBBBBBBBBBBBBBBBBBBBB',
          } as never,
          bundle: {
            projection: {
              format: leaseV1().projection.format,
              document: { pages: [{ pageId: 'page_1' }] },
            },
          } as never,
          apiOrigin: 'http://127.0.0.1:3411',
          webOrigin: 'http://127.0.0.1:3000',
          artifactRuntimeOrigin: 'http://127.0.0.1:3412',
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 50,
          async renewHold() {},
          async releaseHold() {
            attempts.hold += 1;
            if (attempts.hold === 1) throw new Error('fixture hold release failure');
          },
        }),
      );
    });
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 0);
    assert.deepEqual(attempts, {
      page: 2,
      context: 2,
      browser: 2,
      brokerDispose: 2,
      brokerRenew: 2,
      hold: 2,
      popup: 2,
      download: 2,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('renderer hold release clears a rejected in-flight attempt and succeeds on retry', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  let releaseAttempts = 0;
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate() {
      return true;
    },
    async screenshot() {
      return PNG;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  const renderer = new ExportRendererServiceV1(
    { async renew() {}, async dispose() {} } as never,
    {
      async launch() {
        return {
          async newContext() {
            return context;
          },
          async close() {},
        };
      },
    } as never,
  );
  try {
    const lease = await renderer.render({
      credentials: {
        sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
        token: 'BBBBBBBBBBBBBBBBBBBBBB',
      } as never,
      bundle: {
        projection: {
          format: leaseV1().projection.format,
          document: { pages: [{ pageId: 'page_1' }] },
        },
      } as never,
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1_000,
      async renewHold() {},
      async releaseHold() {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error('fixture hold release failure');
      },
    });
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 1);
    await lease.completeResponse();
    await lease.completeResponse();
    assert.equal(releaseAttempts, 2);
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 0);
  } finally {
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
});

test('renderer exposes post-render hold loss and retains capacity through terminal cleanup', async () => {
  const previousExecutable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = '/fixture/chromium';
  const intervalCallbacks: Array<() => void> = [];
  globalThis.setInterval = ((handler: () => void) => {
    intervalCallbacks.push(handler);
    return {
      unref() {
        return this;
      },
    } as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate() {
      return true;
    },
    async screenshot() {
      return PNG;
    },
    async close() {},
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {},
  };
  let releaseHold: (() => void) | undefined;
  const holdReleased = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let holdReleaseAttempts = 0;
  const renderer = new ExportRendererServiceV1(
    { async renew() {}, async dispose() {} } as never,
    {
      async launch() {
        return {
          async newContext() {
            return context;
          },
          async close() {},
        };
      },
    } as never,
  );
  try {
    const lease = await renderer.render({
      credentials: {
        sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
        token: 'BBBBBBBBBBBBBBBBBBBBBB',
      } as never,
      bundle: {
        projection: {
          format: leaseV1().projection.format,
          document: { pages: [{ pageId: 'page_1' }] },
        },
      } as never,
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1_000,
      async renewHold() {
        throw new Error('fixture post-render hold renewal loss');
      },
      async releaseHold() {
        holdReleaseAttempts += 1;
        await holdReleased;
      },
    });
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 1);
    intervalCallbacks[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lease.ownershipSignal.aborted, true);
    assert.throws(
      () => lease.assertOwnership(),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDERER_UNAVAILABLE',
    );
    assert.equal(holdReleaseAttempts, 1);
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 1);
    const cleanup = lease.abort();
    releaseHold?.();
    await cleanup;
    assert.equal((renderer as unknown as { activeRenders: number }).activeRenders, 0);
    assert.equal(getEventListeners(lease.ownershipSignal, 'abort').length, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (previousExecutable === undefined) delete process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
    else process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = previousExecutable;
  }
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

  removeHeader(name: string): void {
    this.values.delete(name);
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

  destroy(): this {
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

test('HTTP finish seals completion before a queued ownership loss can reclassify it', async () => {
  const ownership = new AbortController();
  const events: string[] = [];
  let failedAudits = 0;
  const lease = {
    ...leaseV1(),
    ownershipSignal: ownership.signal,
    assertOwnership() {
      if (ownership.signal.aborted) throw ownership.signal.reason;
    },
    async auditFailed() {
      failedAudits += 1;
    },
    async completeResponse() {
      events.push('completed');
    },
  };
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
  class FinishThenLoseOwnershipResponseV1 extends ResponseV1 {
    override end(bytes: Buffer): this {
      this.headersSent = true;
      this.body = bytes;
      queueMicrotask(() => {
        events.push('finish');
        this.emit('finish');
      });
      queueMicrotask(() => {
        events.push('ownership-lost');
        ownership.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE'));
      });
      return this;
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new FinishThenLoseOwnershipResponseV1();
  await controller.export(BOARD_ID, requestV1() as never, response as never);
  assert.deepEqual(events, ['finish', 'completed', 'ownership-lost']);
  assert.equal(failedAudits, 0);
});

test('HTTP finish fixes the delivered outcome even when its first cleanup attempt fails', async () => {
  let completionAttempts = 0;
  let failedAudits = 0;
  const lease = {
    ...leaseV1(),
    async auditFailed() {
      failedAudits += 1;
    },
    async completeResponse() {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new Error('fixture cleanup failure');
    },
  };
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
  assert.equal(response.headersSent, true);
  assert.equal(completionAttempts, 2);
  assert.equal(failedAudits, 0);
});

test('HTTP export cannot commit headers or bytes without a durable terminal reservation', async () => {
  let encodeCalls = 0;
  const admission = {
    async admit() {
      throw new Error('fixture durable terminal reservation unavailable');
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      encodeCalls += 1;
      return Buffer.from('%PDF-unreachable', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new ResponseV1();
  await assert.rejects(
    controller.export(BOARD_ID, requestV1() as never, response as never),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
  );
  assert.equal(encodeCalls, 0);
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
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

test('HTTP export does not wait indefinitely for a non-cooperative failed audit', async () => {
  const counters = { complete: 0, abort: 0 };
  let failedAuditAttempts = 0;
  const lease = {
    ...leaseV1(counters),
    auditFailed() {
      failedAuditAttempts += 1;
      return new Promise<void>(() => undefined);
    },
  };
  const admission = {
    async admit() {
      return lease;
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new ResponseV1();
  const outcome = controller.export(BOARD_ID, requestV1() as never, response as never).then(
    () => ({ kind: 'resolved' as const, error: undefined }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  let guard: NodeJS.Timeout | undefined;
  const guardedOutcome = await Promise.race([
    outcome,
    new Promise<{ kind: 'guard'; error: undefined }>((resolve) => {
      guard = setTimeout(() => resolve({ kind: 'guard', error: undefined }), 100);
    }),
  ]);
  if (guard !== undefined) clearTimeout(guard);

  assert.equal(guardedOutcome.kind, 'rejected');
  assert.ok(
    guardedOutcome.error instanceof ExportFailureV1 &&
      guardedOutcome.error.code === 'EXPORT_ENCODE_FAILED',
  );
  assert.equal(failedAuditAttempts, 1);
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export observes a failed audit rejection that arrives after cleanup', async () => {
  const counters = { complete: 0, abort: 0 };
  let rejectFailedAudit: ((error: Error) => void) | undefined;
  const lease = {
    ...leaseV1(counters),
    auditFailed() {
      return new Promise<void>((_resolve, reject) => {
        rejectFailedAudit = reject;
      });
    },
  };
  const admission = {
    async admit() {
      return lease;
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());

  await withoutUnhandledRejections(async () => {
    await assert.rejects(
      controller.export(BOARD_ID, requestV1() as never, new ResponseV1() as never),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
    );
    assert.notEqual(rejectFailedAudit, undefined);
    rejectFailedAudit?.(new Error('fixture late failed audit rejection'));
  });
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export selects the stable timeout outcome when the total deadline wins during failure', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let failedReason = '';
  const counters = { complete: 0, abort: 0 };
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
    async encode() {
      now += EXPORT_TOTAL_TIMEOUT_MS_V1 + 1;
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    },
  } as unknown as PdfExportEncoderV1;
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new ResponseV1();

  try {
    await assert.rejects(
      controller.export(BOARD_ID, requestV1() as never, response as never),
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(failedReason, 'EXPORT_RENDER_TIMEOUT');
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export records a post-header pre-finish transport error as failed without a second response', async () => {
  const counters = { complete: 0, abort: 0 };
  let failedAudits = 0;
  const lease = {
    ...leaseV1(counters),
    async auditFailed() {
      failedAudits += 1;
    },
  };
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
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
  assert.equal(failedAudits, 1);
});

test('HTTP export records ownership loss after headers but before finish as failed', async () => {
  const counters = { complete: 0, abort: 0 };
  let failedAudits = 0;
  const ownership = new AbortController();
  const lease = {
    ...leaseV1(counters),
    ownershipSignal: ownership.signal,
    assertOwnership() {
      if (ownership.signal.aborted) throw ownership.signal.reason;
    },
    async auditFailed() {
      failedAudits += 1;
    },
  };
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
  class CommittedHangingTransportResponseV1 extends ResponseV1 {
    destroyCalls = 0;

    override end(bytes: Buffer): this {
      this.headersSent = true;
      this.body = bytes;
      return this;
    }

    override destroy(): this {
      this.destroyCalls += 1;
      return this;
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const request = requestV1();
  const response = new CommittedHangingTransportResponseV1();
  const pending = controller.export(BOARD_ID, request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  ownership.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE'));
  await pending;
  assert.equal(response.headersSent, true);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.destroyCalls, 1);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
  assert.equal(failedAudits, 1);
});

test('HTTP export fails closed when ownership is lost during an uncommitted response write', async () => {
  const counters = { complete: 0, abort: 0 };
  const ownership = new AbortController();
  let failedReason = '';
  const lease = {
    ...leaseV1(counters),
    ownershipSignal: ownership.signal,
    assertOwnership() {
      if (ownership.signal.aborted) throw ownership.signal.reason;
    },
    async auditCompleted() {},
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
    async encode() {
      return Buffer.from('%PDF-fixture', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  class UncommittedHangingTransportResponseV1 extends ResponseV1 {
    destroyCalls = 0;

    override end(_bytes: Buffer): this {
      queueMicrotask(() => ownership.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE')));
      return this;
    }

    override destroy(): this {
      this.destroyCalls += 1;
      return this;
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const response = new UncommittedHangingTransportResponseV1();
  await assert.rejects(
    controller.export(BOARD_ID, requestV1() as never, response as never),
    (error: unknown) =>
      error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDERER_UNAVAILABLE',
  );
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
  assert.equal(response.destroyCalls, 1);
  assert.equal(getEventListeners(ownership.signal, 'abort').length, 0);
  assert.equal(failedReason, 'EXPORT_RENDERER_UNAVAILABLE');
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export clears staged headers and aborts once when response.end throws before commit', async () => {
  const counters = { complete: 0, abort: 0 };
  const admission = {
    async admit() {
      return leaseV1(counters);
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      return Buffer.from('%PDF-fixture', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  class SynchronousFailedTransportResponseV1 extends ResponseV1 {
    override end(_bytes: Buffer): this {
      throw new Error('fixture synchronous transport failure');
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const request = requestV1();
  const response = new SynchronousFailedTransportResponseV1();
  await assert.rejects(
    controller.export(BOARD_ID, request as never, response as never),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_ENCODE_FAILED',
  );
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.body, null);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
});

test('HTTP export end without finish settles on client abort and removes every listener', async () => {
  const counters = { complete: 0, abort: 0 };
  const admission = {
    async admit() {
      return leaseV1(counters);
    },
  } as unknown as ExportAdmissionServiceV1;
  const pdf = {
    async encode() {
      return Buffer.from('%PDF-fixture', 'ascii');
    },
  } as unknown as PdfExportEncoderV1;
  class HangingTransportResponseV1 extends ResponseV1 {
    override end(_bytes: Buffer): this {
      return this;
    }
  }
  const controller = new ExportControllerV1(admission, pdf, new PptxExportEncoderV1());
  const request = requestV1();
  const response = new HangingTransportResponseV1();
  const pending = controller.export(BOARD_ID, request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  request.aborted = true;
  request.emit('aborted');
  await pending;
  assert.equal(response.headersSent, false);
  assert.equal(response.values.size, 0);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('error'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.deepEqual(counters, { complete: 0, abort: 1 });
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
