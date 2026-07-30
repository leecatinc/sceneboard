'use client';

import { inspectExportReadinessV1 } from '@sceneboard/artifact-runtime/export';
import {
  BoardDocumentParserV3,
  BoardIdParserV1,
  GlobalIdStringParserV1,
  presentationFormatDescriptorV1,
  type PresentationFormatDescriptorV1,
} from '@sceneboard/board-schema';
import {
  ExportBoardRenderer,
  type ExportProjectionResourceV1,
  type ExportProjectionV1,
} from '@sceneboard/board-ui/export';
import { useEffect, useRef, useState } from 'react';

const PROJECTION_MEDIA_TYPE_V1 = 'application/vnd.sceneboard.export-projection+json';
const RESOURCE_TYPES_V1 = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'font/woff2',
  'application/vnd.sceneboard.artifact-package+zip',
]);
const SHA256_V1 = /^[a-f0-9]{64}$/u;

declare global {
  interface Window {
    __SCENEBOARD_EXPORT__?: {
      ready: boolean;
      renderPage(index: number): Promise<boolean>;
    };
  }
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
};

const parseResource = (
  input: unknown,
  apiOrigin: string,
  sessionId: string,
): ExportProjectionResourceV1 | null => {
  const value = record(input);
  const usage = record(value?.usage);
  if (
    value === null ||
    usage === null ||
    !exactKeys(value, ['sha256', 'mediaType', 'byteLength', 'url', 'usage']) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_V1.test(value.sha256) ||
    typeof value.mediaType !== 'string' ||
    !RESOURCE_TYPES_V1.has(value.mediaType) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    typeof value.url !== 'string' ||
    value.url !== `/internal/v1/export-render/${sessionId}/resources/${value.sha256}`
  )
    return null;
  const identity =
    usage.kind === 'media' &&
    exactKeys(usage, ['kind', 'mediaId']) &&
    GlobalIdStringParserV1.parse(usage.mediaId).ok
      ? usage
      : usage.kind === 'artifact' &&
          exactKeys(usage, ['kind', 'artifactId', 'versionId']) &&
          GlobalIdStringParserV1.parse(usage.artifactId).ok &&
          GlobalIdStringParserV1.parse(usage.versionId).ok
        ? usage
        : usage.kind === 'font' &&
            exactKeys(usage, ['kind', 'family', 'subset']) &&
            usage.family === 'Noto Sans KR' &&
            (usage.subset === 'korean' || usage.subset === 'latin')
          ? usage
          : null;
  if (identity === null) return null;
  return {
    sha256: value.sha256,
    mediaType: value.mediaType as ExportProjectionResourceV1['mediaType'],
    byteLength: value.byteLength as number,
    url: new URL(value.url, apiOrigin).href,
    usage: identity as ExportProjectionResourceV1['usage'],
  };
};

const parseProjection = (
  input: unknown,
  apiOrigin: string,
  sessionId: string,
): ExportProjectionV1 | null => {
  const value = record(input);
  if (
    value === null ||
    !exactKeys(value, [
      'schemaVersion',
      'boardId',
      'revisionId',
      'revisionNumber',
      'document',
      'format',
      'resources',
    ]) ||
    value.schemaVersion !== 1 ||
    !BoardIdParserV1.parse(value.boardId).ok ||
    !GlobalIdStringParserV1.parse(value.revisionId).ok ||
    !Number.isSafeInteger(value.revisionNumber) ||
    (value.revisionNumber as number) < 1 ||
    !Array.isArray(value.resources)
  )
    return null;
  const document = BoardDocumentParserV3.parse(value.document);
  if (!document.ok) return null;
  const expectedFormat = presentationFormatDescriptorV1(document.data.value.format);
  if (canonicalJson(value.format) !== canonicalJson(expectedFormat)) return null;
  const resources = value.resources.map((item) => parseResource(item, apiOrigin, sessionId));
  if (resources.some((item) => item === null)) return null;
  return {
    schemaVersion: 1,
    boardId: value.boardId as ExportProjectionV1['boardId'],
    revisionId: value.revisionId as ExportProjectionV1['revisionId'],
    revisionNumber: value.revisionNumber as number,
    document: document.data.value,
    format: expectedFormat as PresentationFormatDescriptorV1,
    resources: resources as ExportProjectionResourceV1[],
  };
};

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const waitUntilReady = async (root: ParentNode, deadlineMs: number): Promise<boolean> => {
  while (performance.now() < deadlineMs) {
    await document.fonts.ready;
    await nextFrame();
    const status = inspectExportReadinessV1(root);
    if (status.ready) return true;
    if (status.reason === 'unsupported') return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

const installFonts = (projection: ExportProjectionV1): void => {
  const rules = projection.resources.flatMap((resource) =>
    resource.usage.kind === 'font'
      ? [
          `@font-face{font-family:"Noto Sans KR";font-style:normal;font-weight:400;font-display:block;src:url("${resource.url}") format("woff2");unicode-range:${
            resource.usage.subset === 'korean'
              ? 'U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7AF,U+D7B0-D7FF,U+3000-303F,U+FF00-FFEF'
              : 'U+0000-024F,U+1E00-1EFF,U+2000-206F'
          };}`,
        ]
      : [],
  );
  const style = document.createElement('style');
  style.dataset.exportFonts = 'v1';
  style.textContent = rules.join('');
  document.head.append(style);
};

export function ExportRenderClient({
  sessionId,
  apiOrigin,
  runtimeOrigin,
}: {
  sessionId: string;
  apiOrigin: string;
  runtimeOrigin: string;
}) {
  const [projection, setProjection] = useState<ExportProjectionV1 | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageIndexRef = useRef(0);
  pageIndexRef.current = pageIndex;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        `${apiOrigin}/internal/v1/export-render/${sessionId}/projection`,
        {
          method: 'GET',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (
        response.status !== 200 ||
        response.headers.get('content-type') !== PROJECTION_MEDIA_TYPE_V1
      )
        throw new TypeError('export projection is unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > 1_048_576)
        throw new TypeError('export projection exceeds its bounds');
      const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const parsed = parseProjection(decoded, apiOrigin, sessionId);
      if (parsed === null) throw new TypeError('export projection is invalid');
      installFonts(parsed);
      setProjection(parsed);
    })().catch(() => {
      document.body.dataset.exportFailed = 'true';
    });
    return () => controller.abort();
  }, [apiOrigin, sessionId]);

  useEffect(() => {
    if (projection === null) return;
    window.__SCENEBOARD_EXPORT__ = {
      ready: true,
      async renderPage(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= projection.document.pages.length)
          return false;
        setPageIndex(index);
        while (pageIndexRef.current !== index) await nextFrame();
        const root = rootRef.current;
        return root === null ? false : waitUntilReady(root, performance.now() + 10_000);
      },
    };
    return () => {
      delete window.__SCENEBOARD_EXPORT__;
    };
  }, [projection]);

  if (projection === null) return <main aria-busy="true" />;
  return (
    <div
      ref={rootRef}
      style={{
        width: projection.format.css.width,
        height: projection.format.css.height,
        overflow: 'hidden',
      }}
    >
      <ExportBoardRenderer
        projection={projection}
        pageIndex={pageIndex}
        runtimeOrigin={runtimeOrigin}
      />
    </div>
  );
}
