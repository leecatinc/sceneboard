import type { ExportFormatV1 } from './export-request.schema.js';

export const EXPORT_CONTENT_TYPES_V1 = Object.freeze({
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const satisfies Readonly<Record<ExportFormatV1, string>>);

export const safeExportTitleV1 = (title: string): string => {
  const safe = title
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/\.+/gu, '.')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 80)
    .replace(/[._-]+$/gu, '');
  return safe === '' ? 'sceneboard' : safe;
};

export const exportFilenameV1 = (
  title: string,
  revisionNumber: number,
  format: ExportFormatV1,
): string => `${safeExportTitleV1(title)}-r${revisionNumber}.${format}`;

export const exportSuccessHeadersV1 = (input: {
  title: string;
  revisionNumber: number;
  format: ExportFormatV1;
  byteLength: number;
}): Readonly<Record<string, string>> =>
  Object.freeze({
    'Content-Type': EXPORT_CONTENT_TYPES_V1[input.format],
    'Content-Disposition': `attachment; filename="${exportFilenameV1(
      input.title,
      input.revisionNumber,
      input.format,
    )}"`,
    'Content-Length': String(input.byteLength),
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
