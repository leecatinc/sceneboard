import { inflateRawSync } from 'node:zlib';

import PptxGenJS from 'pptxgenjs';

import { ExportFailureV1 } from './export-errors.js';
import { safeExportTitleV1 } from './export-http-response.js';
import type { ExportRenderLeaseV1, ExportRenderedPageV1 } from './export-renderer.service.js';
import {
  EXPORT_RENDERED_PAGE_MAX_BYTES_V1,
  EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1,
} from './export-request.schema.js';

const PNG_SIGNATURE_V1 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_LOCAL_SIGNATURE_V1 = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE_V1 = 0x02014b50;
const ZIP_END_SIGNATURE_V1 = 0x06054b50;
const ZIP_FIXED_DATE_V1 = 0x0021;

type ZipEntryV1 = Readonly<{ name: string; bytes: Buffer }>;

type PptxPresentationV1 = {
  layout: string;
  author: string;
  company: string;
  title: string;
  subject: string;
  revision: string;
  defineLayout(input: { name: string; width: number; height: number }): void;
  addSlide(): {
    background: { color: string };
    addImage(input: { data: string; x: number; y: number; w: number; h: number }): unknown;
  };
  write(input: {
    outputType: 'nodebuffer';
    compression: boolean;
  }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
};

const PptxGenJSConstructor = (() => {
  const imported = PptxGenJS as unknown;
  const candidate =
    typeof imported === 'function'
      ? imported
      : imported !== null && typeof imported === 'object' && 'default' in imported
        ? imported.default
        : null;
  if (typeof candidate !== 'function') return null;
  return candidate as new () => PptxPresentationV1;
})();

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
  let offset = bytes.readUInt32LE(end + 16);
  const entries: ZipEntryV1[] = [];
  const names = new Set<string>();
  for (let index = 0; index < count; index += 1) {
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
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (
      name === '' ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      names.has(name) ||
      bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE_V1
    )
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    names.add(name);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const content =
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
            })();
    if (content.byteLength !== uncompressedSize || crc32V1(content) !== expectedCrc)
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    if (!name.endsWith('/')) entries.push(Object.freeze({ name, bytes: content }));
    offset += 46 + nameLength + extraLength + commentLength;
  }
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
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
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
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIGNATURE_V1, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBytes, end]);
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

export class PptxExportEncoderV1 {
  async encode(input: {
    lease: ExportRenderLeaseV1;
    boardTitle: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    assertCompletePages(input.lease.pages);
    input.signal?.throwIfAborted();
    try {
      const descriptor = input.lease.projection.format.pptx;
      if (PptxGenJSConstructor === null) throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
      const presentation = new PptxGenJSConstructor();
      presentation.defineLayout({
        name: 'SCENEBOARD_EXPORT_V1',
        width: descriptor.widthIn,
        height: descriptor.heightIn,
      });
      presentation.layout = 'SCENEBOARD_EXPORT_V1';
      presentation.author = 'SceneBoard';
      presentation.company = 'SceneBoard';
      presentation.title = safeExportTitleV1(input.boardTitle);
      presentation.subject = 'SceneBoard fixed-layout export';
      presentation.revision = String(input.lease.projection.revisionNumber);
      for (const page of input.lease.pages) {
        const slide = presentation.addSlide();
        slide.background = { color: 'FFFFFF' };
        slide.addImage({
          data: `image/png;base64,${page.png.toString('base64')}`,
          x: 0,
          y: 0,
          w: descriptor.widthIn,
          h: descriptor.heightIn,
        });
      }
      input.signal?.throwIfAborted();
      const output = await presentation.write({ outputType: 'nodebuffer', compression: true });
      input.signal?.throwIfAborted();
      if (!(output instanceof Uint8Array)) throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
      return canonicalizePptxBytesV1(Buffer.from(output), input.lease.generatedAt);
    } catch (error) {
      if (error instanceof ExportFailureV1 || input.signal?.aborted === true) throw error;
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED', error);
    }
  }
}
