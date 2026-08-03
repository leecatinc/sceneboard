import { createRequire } from 'node:module';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  type WorkerOptions,
} from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';

import { ExportFailureV1 } from './export-errors.js';
import { safeExportTitleV1 } from './export-http-response.js';
import type { ExportRenderLeaseV1, ExportRenderedPageV1 } from './export-renderer.service.js';
import {
  EXPORT_ENCODE_TIMEOUT_MS_V1,
  EXPORT_MAX_PAGES_V1,
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
} from './export-request.schema.js';

const PNG_SIGNATURE_V1 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_LOCAL_SIGNATURE_V1 = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE_V1 = 0x02014b50;
const ZIP_END_SIGNATURE_V1 = 0x06054b50;
const ZIP_FIXED_DATE_V1 = 0x0021;
const PPTX_ZIP_MAX_ENTRIES_V1 = 4_096;
const PPTX_ZIP_ENTRY_MAX_BYTES_V1 = EXPORT_RENDERED_PAGE_MAX_BYTES_V1 + 1_048_576;
const PPTX_ARCHIVE_MAX_BYTES_V1 = EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 + 16_777_216;
const PPTX_INFLATED_TOTAL_MAX_BYTES_V1 = PPTX_ARCHIVE_MAX_BYTES_V1;
const PPTX_BASE64_TOTAL_MAX_BYTES_V1 =
  Math.ceil(EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 / 3) * 4 + 4 * EXPORT_MAX_PAGES_V1;

type ZipEntryV1 = Readonly<{ name: string; bytes: Buffer }>;

type PptxWorkerInputV1 = Readonly<{
  widthIn: number;
  heightIn: number;
  title: string;
  revision: string;
  generatedAt: string;
  pages: readonly Uint8Array[];
}>;

type PptxWorkerResultV1 =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{
      ok: false;
      code: 'EXPORT_BOUNDS_EXCEEDED' | 'EXPORT_ENCODE_FAILED' | 'EXPORT_RENDERER_UNAVAILABLE';
    }>;

type PptxWorkerV1 = Pick<Worker, 'once' | 'off' | 'postMessage' | 'terminate'>;

const PPTXGENJS_PATH_V1 = createRequire(import.meta.url).resolve('pptxgenjs');
const TRANSFER_COPY_CHUNK_BYTES_V1 = 262_144;

const reportCleanupFailure = (error: unknown): void => {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
    code: 'SCENEBOARD_EXPORT_CLEANUP_FAILED',
  });
};

const crcTableV1 = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32V1 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTableV1[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
};

const endOfCentralDirectory = (bytes: Buffer): number => {
  if (bytes.byteLength < 22 || bytes.byteLength > PPTX_ARCHIVE_MAX_BYTES_V1)
    throw new ExportFailureV1(
      bytes.byteLength > PPTX_ARCHIVE_MAX_BYTES_V1
        ? 'EXPORT_BOUNDS_EXCEEDED'
        : 'EXPORT_ENCODE_FAILED',
    );
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65_557);
    offset -= 1
  )
    if (bytes.readUInt32LE(offset) === ZIP_END_SIGNATURE_V1) return offset;
  throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
};

const readZipV1 = (bytes: Buffer): ZipEntryV1[] => {
  const end = endOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (
    count > PPTX_ZIP_MAX_ENTRIES_V1 ||
    offset > end ||
    centralSize > end ||
    offset + centralSize !== end
  )
    throw new ExportFailureV1(
      count > PPTX_ZIP_MAX_ENTRIES_V1 ? 'EXPORT_BOUNDS_EXCEEDED' : 'EXPORT_ENCODE_FAILED',
    );
  const entries: ZipEntryV1[] = [];
  const names = new Set<string>();
  let inflatedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE_V1)
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    inflatedBytes += uncompressedSize;
    if (
      nextOffset > end ||
      uncompressedSize > PPTX_ZIP_ENTRY_MAX_BYTES_V1 ||
      inflatedBytes > PPTX_INFLATED_TOTAL_MAX_BYTES_V1
    )
      throw new ExportFailureV1(
        uncompressedSize > PPTX_ZIP_ENTRY_MAX_BYTES_V1 ||
          inflatedBytes > PPTX_INFLATED_TOTAL_MAX_BYTES_V1
          ? 'EXPORT_BOUNDS_EXCEEDED'
          : 'EXPORT_ENCODE_FAILED',
      );
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (
      name === '' ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      names.has(name) ||
      localOffset + 30 > bytes.byteLength ||
      bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE_V1
    )
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    names.add(name);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset > bytes.byteLength || compressedSize > bytes.byteLength - dataOffset)
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const content =
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: uncompressedSize })
          : (() => {
              throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
            })();
    if (content.byteLength !== uncompressedSize || crc32V1(content) !== expectedCrc)
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    if (!name.endsWith('/')) entries.push(Object.freeze({ name, bytes: content }));
    offset = nextOffset;
  }
  if (offset !== end) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  return entries;
};

export const readCanonicalPptxEntriesV1 = (bytes: Buffer): ReadonlyMap<string, Buffer> =>
  new Map(readZipV1(bytes).map((entry) => [entry.name, Buffer.from(entry.bytes)]));

const removeXmlElements = (xml: string, expression: RegExp): string => xml.replace(expression, '');

const normalizeEntryV1 = (entry: ZipEntryV1, generatedAt: string): ZipEntryV1 | null => {
  if (entry.name.startsWith('ppt/notesMasters/') || entry.name.startsWith('ppt/notesSlides/'))
    return null;
  if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) return entry;
  let xml = entry.bytes.toString('utf8');
  if (entry.name === 'docProps/core.xml') {
    const created = xml.match(/<dcterms:created\b[^>]*>[^<]*<\/dcterms:created>/gu) ?? [];
    const modified = xml.match(/<dcterms:modified\b[^>]*>[^<]*<\/dcterms:modified>/gu) ?? [];
    if (created.length !== 1 || modified.length !== 1)
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    xml = xml
      .replace(
        /<dcterms:created([^>]*)>[^<]*<\/dcterms:created>/gu,
        `<dcterms:created$1>${generatedAt}</dcterms:created>`,
      )
      .replace(
        /<dcterms:modified([^>]*)>[^<]*<\/dcterms:modified>/gu,
        `<dcterms:modified$1>${generatedAt}</dcterms:modified>`,
      );
  }
  if (entry.name === '[Content_Types].xml')
    xml = removeXmlElements(
      xml,
      /<Override\b[^>]*PartName="\/ppt\/notes(?:Masters|Slides)\/[^"]+"[^>]*\/>/gu,
    );
  if (entry.name === 'ppt/presentation.xml')
    xml = removeXmlElements(xml, /<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/gu);
  if (
    entry.name === 'ppt/_rels/presentation.xml.rels' ||
    /^ppt\/slides\/_rels\/slide[0-9]+\.xml\.rels$/u.test(entry.name)
  )
    xml = removeXmlElements(
      xml,
      /<Relationship\b(?=[^>]*Type="[^"]*\/notes(?:Master|Slide)")[^>]*\/>/gu,
    );
  return Object.freeze({ name: entry.name, bytes: Buffer.from(xml, 'utf8') });
};

const writeZipV1 = (entries: readonly ZipEntryV1[]): Buffer => {
  if (entries.length > PPTX_ZIP_MAX_ENTRIES_V1)
    throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let centralLength = 0;
  for (const entry of entries) {
    if (entry.bytes.byteLength > PPTX_ZIP_ENTRY_MAX_BYTES_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    const name = Buffer.from(entry.name, 'utf8');
    if (name.byteLength > 65_535) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    const crc = crc32V1(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE_V1, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_FIXED_DATE_V1, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE_V1, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_FIXED_DATE_V1, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + entry.bytes.byteLength;
    centralLength += central.byteLength + name.byteLength;
    if (localOffset + centralLength + 22 > PPTX_ARCHIVE_MAX_BYTES_V1)
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
  }
  const centralBytes = Buffer.concat(centralParts, centralLength);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIGNATURE_V1, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBytes, end], localOffset + centralLength + end.length);
};

export const canonicalizePptxBytesV1 = (bytes: Buffer, generatedAt: string): Buffer => {
  if (!Number.isFinite(new Date(generatedAt).getTime()))
    throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  const entries = readZipV1(bytes)
    .map((entry) => normalizeEntryV1(entry, generatedAt))
    .filter((entry): entry is ZipEntryV1 => entry !== null)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const names = new Set(entries.map(({ name }) => name));
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/core.xml',
    'ppt/presentation.xml',
  ])
    if (!names.has(required)) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  if (
    entries.some(
      ({ name, bytes: entryBytes }) =>
        (name.endsWith('.xml') || name.endsWith('.rels')) &&
        /notes(?:Master|Slide)/u.test(entryBytes.toString('utf8')),
    )
  )
    throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  return writeZipV1(entries);
};

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

const workerEntryPointV1 = (): URL => {
  const moduleUrl = new URL(import.meta.url);
  if (!/\.[cm]?ts$/u.test(moduleUrl.pathname)) return moduleUrl;
  const bootstrap = `import { tsImport } from ${JSON.stringify(
    import.meta.resolve('tsx/esm/api'),
  )}; await tsImport(${JSON.stringify(moduleUrl.href)}, import.meta.url);`;
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
};

const createPptxWorkerV1 = (): PptxWorkerV1 =>
  new Worker(workerEntryPointV1(), {
    workerData: { sceneboardPptxWorkerV1: true },
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

const preparePptxWorkerInputV1 = async (
  input: PptxWorkerInputV1,
  isCancelled: () => boolean,
): Promise<Readonly<{ input: PptxWorkerInputV1; transferList: readonly ArrayBuffer[] }> | null> => {
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

const runPptxWorkerV1 = (
  worker: PptxWorkerV1,
  input: PptxWorkerInputV1,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    let terminated = false;
    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      void Promise.resolve()
        .then(() => worker.terminate())
        .catch(reportCleanupFailure);
    };
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
      terminate();
      reject(error);
    };
    const aborted = (): void =>
      settleFailure(new ExportFailureV1('EXPORT_RENDER_TIMEOUT'));
    const message = (value: unknown): void => {
      if (terminal) return;
      if (
        value === null ||
        typeof value !== 'object' ||
        !('ok' in value) ||
        typeof value.ok !== 'boolean'
      ) {
        settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED'));
        return;
      }
      const result = value as PptxWorkerResultV1;
      if (!result.ok) {
        settleFailure(
          new ExportFailureV1(
            result.code === 'EXPORT_BOUNDS_EXCEEDED' ||
              result.code === 'EXPORT_RENDERER_UNAVAILABLE'
              ? result.code
              : 'EXPORT_ENCODE_FAILED',
          ),
        );
        return;
      }
      if (!(result.bytes instanceof Uint8Array)) {
        settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED'));
        return;
      }
      if (result.bytes.byteLength > PPTX_ARCHIVE_MAX_BYTES_V1) {
        settleFailure(new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED'));
        return;
      }
      terminal = true;
      cleanup();
      terminate();
      resolve(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
    };
    const failed = (error: Error): void =>
      settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED', error));
    const exited = (code: number): void => {
      if (terminal) return;
      settleFailure(
        new ExportFailureV1('EXPORT_ENCODE_FAILED', new Error(`PPTX worker exited with ${code}`)),
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
    void preparePptxWorkerInputV1(input, () => terminal)
      .then((prepared) => {
        if (terminal || prepared === null) return;
        worker.postMessage(prepared.input, prepared.transferList);
      })
      .catch((error: unknown) => {
        if (!terminal) settleFailure(new ExportFailureV1('EXPORT_ENCODE_FAILED', error));
      });
  });

export class PptxExportEncoderV1 {
  constructor(
    private readonly createWorker: () => PptxWorkerV1 = createPptxWorkerV1,
  ) {}

  async encode(input: {
    lease: ExportRenderLeaseV1;
    boardTitle: string;
    signal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<Buffer> {
    assertCompletePages(input.lease.pages);
    input.signal?.throwIfAborted();
    try {
      const descriptor = input.lease.projection.format.pptx;
      const signal = input.signal ?? new AbortController().signal;
      const deadlineMs = Math.min(
        input.deadlineMs ?? Number.POSITIVE_INFINITY,
        Date.now() + EXPORT_ENCODE_TIMEOUT_MS_V1,
      );
      const workerInput: PptxWorkerInputV1 = {
        widthIn: descriptor.widthIn,
        heightIn: descriptor.heightIn,
        title: safeExportTitleV1(input.boardTitle),
        revision: String(input.lease.projection.revisionNumber),
        generatedAt: input.lease.generatedAt,
        pages: input.lease.pages.map((page) => page.png),
      };
      const output = await runPptxWorkerV1(
        this.createWorker(),
        workerInput,
        signal,
        deadlineMs,
      );
      input.signal?.throwIfAborted();
      return output;
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      if (input.signal?.aborted === true) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT', error);
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED', error);
    }
  }
}

const encodeAndCanonicalizePptxV1 = async (input: PptxWorkerInputV1): Promise<Buffer> => {
  if (input.pages.length === 0 || input.pages.length > EXPORT_MAX_PAGES_V1)
    throw new ExportFailureV1(
      input.pages.length > EXPORT_MAX_PAGES_V1
        ? 'EXPORT_BOUNDS_EXCEEDED'
        : 'EXPORT_ENCODE_FAILED',
    );
  let pageBytes = 0;
  let base64Bytes = 0;
  const encodedPages: string[] = [];
  for (const png of input.pages) {
    pageBytes += png.byteLength;
    base64Bytes += Math.ceil(png.byteLength / 3) * 4;
    if (
      png.byteLength > EXPORT_RENDERED_PAGE_MAX_BYTES_V1 ||
      pageBytes > EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 ||
      base64Bytes > PPTX_BASE64_TOTAL_MAX_BYTES_V1
    )
      throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
    if (
      png.byteLength < PNG_SIGNATURE_V1.byteLength ||
      !Buffer.from(
        png.buffer,
        png.byteOffset,
        PNG_SIGNATURE_V1.byteLength,
      ).equals(PNG_SIGNATURE_V1)
    )
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    encodedPages.push(
      Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64'),
    );
  }
  const imported = createRequire(import.meta.url)(PPTXGENJS_PATH_V1) as unknown;
  const Constructor =
    typeof imported === 'function'
      ? imported
      : (imported as { default?: unknown } | null)?.default;
  if (typeof Constructor !== 'function') throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
  const presentation = new (Constructor as new () => {
    defineLayout(value: { name: string; width: number; height: number }): void;
    layout: string;
    author: string;
    company: string;
    title: string;
    subject: string;
    revision: string;
    addSlide(): {
      background: { color: string };
      addImage(value: { data: string; x: number; y: number; w: number; h: number }): void;
    };
    write(value: { outputType: 'nodebuffer'; compression: true }): Promise<unknown>;
  })();
  presentation.defineLayout({
    name: 'SCENEBOARD_EXPORT_V1',
    width: input.widthIn,
    height: input.heightIn,
  });
  presentation.layout = 'SCENEBOARD_EXPORT_V1';
  presentation.author = 'SceneBoard';
  presentation.company = 'SceneBoard';
  presentation.title = input.title;
  presentation.subject = 'SceneBoard fixed-layout export';
  presentation.revision = input.revision;
  for (const png of encodedPages) {
    const slide = presentation.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addImage({
      data: `image/png;base64,${png}`,
      x: 0,
      y: 0,
      w: input.widthIn,
      h: input.heightIn,
    });
  }
  const output = await presentation.write({ outputType: 'nodebuffer', compression: true });
  if (!(output instanceof Uint8Array)) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
  if (output.byteLength > PPTX_ARCHIVE_MAX_BYTES_V1)
    throw new ExportFailureV1('EXPORT_BOUNDS_EXCEEDED');
  return canonicalizePptxBytesV1(
    Buffer.from(output.buffer, output.byteOffset, output.byteLength),
    input.generatedAt,
  );
};

if (
  !isMainThread &&
  workerData !== null &&
  typeof workerData === 'object' &&
  workerData.sceneboardPptxWorkerV1 === true
) {
  parentPort?.once('message', (input: PptxWorkerInputV1) => {
    void encodeAndCanonicalizePptxV1(input)
      .then((bytes) => {
        const output = Uint8Array.from(bytes);
        parentPort?.postMessage({ ok: true, bytes: output } satisfies PptxWorkerResultV1, [
          output.buffer,
        ]);
      })
      .catch((error: unknown) => {
        parentPort?.postMessage({
          ok: false,
          code:
            error instanceof ExportFailureV1 &&
            (error.code === 'EXPORT_BOUNDS_EXCEEDED' ||
              error.code === 'EXPORT_RENDERER_UNAVAILABLE')
              ? error.code
              : 'EXPORT_ENCODE_FAILED',
        } satisfies PptxWorkerResultV1);
      });
  });
}
