import { z } from 'zod';

import type { ArtifactReferenceV1 } from './artifacts.js';
import {
  BoardIdSchemaV1,
  createScalarTextSchemaV1,
  PageIdSchemaV1,
  RevisionIdSchemaV1,
  type BoardId,
  type PageId,
  type RevisionId,
} from './identifiers.js';
import { MAX_DOCUMENT_NODES, MAX_DOCUMENT_PAGES, MAX_TITLE_CHARS } from './limits.js';
import { collectSceneNodesV1, SceneSchemaV1, type BoardNodeV1, type SceneV1 } from './scene.js';

export const PageDisplayModeSchemaV1 = z.enum(['fit-page', 'fit-width', 'actual-size']);
export const PresentationFormatSchemaV1 = z.enum([
  'wide_16_9',
  'standard_4_3',
  'a4_portrait',
  'a4_landscape',
]);

export type PresentationFormatV1 = z.infer<typeof PresentationFormatSchemaV1>;

export interface PresentationFormatDescriptorV1 {
  format: PresentationFormatV1;
  css: { width: number; height: number };
  pdf: { widthMm: number; heightMm: number };
  pptx: { widthIn: number; heightIn: number };
}

const PRESENTATION_FORMAT_DESCRIPTORS_V1 = {
  wide_16_9: {
    format: 'wide_16_9',
    css: { width: 1600, height: 900 },
    pdf: { widthMm: 338.67, heightMm: 190.5 },
    pptx: { widthIn: 13.333, heightIn: 7.5 },
  },
  standard_4_3: {
    format: 'standard_4_3',
    css: { width: 1600, height: 1200 },
    pdf: { widthMm: 254, heightMm: 190.5 },
    pptx: { widthIn: 10, heightIn: 7.5 },
  },
  a4_portrait: {
    format: 'a4_portrait',
    css: { width: 794, height: 1123 },
    pdf: { widthMm: 210, heightMm: 297 },
    pptx: { widthIn: 8.2677, heightIn: 11.6929 },
  },
  a4_landscape: {
    format: 'a4_landscape',
    css: { width: 1123, height: 794 },
    pdf: { widthMm: 297, heightMm: 210 },
    pptx: { widthIn: 11.6929, heightIn: 8.2677 },
  },
} as const satisfies Readonly<Record<PresentationFormatV1, PresentationFormatDescriptorV1>>;

export const presentationFormatDescriptorV1 = (
  format: PresentationFormatV1,
): PresentationFormatDescriptorV1 => {
  const descriptor = PRESENTATION_FORMAT_DESCRIPTORS_V1[format];
  return {
    format: descriptor.format,
    css: { ...descriptor.css },
    pdf: { ...descriptor.pdf },
    pptx: { ...descriptor.pptx },
  };
};

export const BoardPageSchemaV2 = z
  .object({
    pageId: PageIdSchemaV1,
    title: createScalarTextSchemaV1(0, MAX_TITLE_CHARS),
    displayMode: PageDisplayModeSchemaV1,
    scene: SceneSchemaV1,
  })
  .strict();

const invalidDocument = (
  context: z.RefinementCtx,
  path: Array<string | number>,
  reason:
    | 'page_count'
    | 'duplicate_page_id'
    | 'default_page_missing'
    | 'invalid_display_mode'
    | 'duplicate_node_id'
    | 'unresolved_reference'
    | 'limit',
  message: string,
) =>
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `[INVALID_DOCUMENT:${reason}] ${message}`,
  });

const validateDocumentPages = (
  document: { defaultPageId: PageId; pages: readonly BoardPageV2[] },
  context: z.RefinementCtx,
) => {
  if (document.pages.length < 1 || document.pages.length > MAX_DOCUMENT_PAGES)
    invalidDocument(context, ['pages'], 'page_count', 'document page count is invalid');

  const pageIds = new Set<string>();
  const nodeIds = new Map<string, Array<string | number>>();
  let nodeCount = 0;
  document.pages.forEach((page, pageIndex) => {
    if (pageIds.has(page.pageId))
      invalidDocument(
        context,
        ['pages', pageIndex, 'pageId'],
        'duplicate_page_id',
        'page IDs must be unique',
      );
    pageIds.add(page.pageId);

    for (const item of collectSceneNodesV1(page.scene.root)) {
      nodeCount += 1;
      const path = ['pages', pageIndex, 'scene', ...item.path, 'id'] as Array<string | number>;
      const firstPath = nodeIds.get(item.node.id);
      if (firstPath)
        invalidDocument(
          context,
          path,
          'duplicate_node_id',
          `duplicate node ID ${item.node.id}; first path ${JSON.stringify(firstPath)}`,
        );
      else nodeIds.set(item.node.id, path);
    }
  });

  if (!pageIds.has(document.defaultPageId))
    invalidDocument(
      context,
      ['defaultPageId'],
      'default_page_missing',
      'default page is not present',
    );
  if (nodeCount > MAX_DOCUMENT_NODES)
    invalidDocument(context, ['pages'], 'limit', 'document node count exceeded');
};

export const BoardDocumentSchemaV2 = z
  .object({
    schemaVersion: z.literal(2),
    defaultPageId: PageIdSchemaV1,
    pages: z.array(BoardPageSchemaV2).min(1).max(MAX_DOCUMENT_PAGES),
  })
  .strict()
  .superRefine(validateDocumentPages);

export const BoardDocumentSchemaV3 = z
  .object({
    schemaVersion: z.literal(3),
    format: PresentationFormatSchemaV1,
    defaultPageId: PageIdSchemaV1,
    pages: z.array(BoardPageSchemaV2).min(1).max(MAX_DOCUMENT_PAGES),
  })
  .strict()
  .superRefine(validateDocumentPages);

export type PageDisplayModeV1 = z.infer<typeof PageDisplayModeSchemaV1>;
export type BoardPageV2 = z.infer<typeof BoardPageSchemaV2>;
export type BoardDocumentV2 = z.infer<typeof BoardDocumentSchemaV2>;
export type BoardDocumentV3 = z.infer<typeof BoardDocumentSchemaV3>;
export type BoardDocument = BoardDocumentV2 | BoardDocumentV3;

export const projectDocumentV2ToV3 = (
  document: BoardDocumentV2,
  format: PresentationFormatV1 = 'wide_16_9',
): BoardDocumentV3 =>
  BoardDocumentSchemaV3.parse({
    schemaVersion: 3,
    format,
    defaultPageId: document.defaultPageId,
    pages: document.pages,
  });

export const projectDocumentV3ToV2 = (document: BoardDocumentV3): BoardDocumentV2 =>
  BoardDocumentSchemaV2.parse({
    schemaVersion: 2,
    defaultPageId: document.defaultPageId,
    pages: document.pages,
  });

export type DocumentSceneTraversalItemV2 = {
  page: BoardPageV2;
  pageIndex: number;
  node: BoardNodeV1;
  path: Array<string | number>;
};

export const collectDocumentNodesV2 = (document: BoardDocument): DocumentSceneTraversalItemV2[] => {
  const output: DocumentSceneTraversalItemV2[] = [];
  document.pages.forEach((page, pageIndex) => {
    for (const item of collectSceneNodesV1(page.scene.root))
      output.push({
        page,
        pageIndex,
        node: item.node as BoardNodeV1,
        path: ['document', 'pages', pageIndex, 'scene', ...item.path],
      });
  });
  return output;
};

const rotateRight = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

const sha256 = (source: string): Uint8Array => {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const input = new TextEncoder().encode(source);
  const bitLength = input.byteLength * 8;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.byteLength] = 0x80;
  new DataView(bytes.buffer).setUint32(paddedLength - 4, bitLength, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temporary1 =
        ((h ?? 0) + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
  return output;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

export const deriveLegacyPageIdV2 = (boardId: BoardId): PageId =>
  PageIdSchemaV1.parse(
    `legacy-${base64Url(sha256(`sceneboard:legacy-page:${boardId}`)).slice(0, 22)}`,
  );

export const adaptLegacySceneToDocumentV2 = (input: {
  boardId: BoardId;
  scene: SceneV1;
}): BoardDocumentV2 => {
  const pageId = deriveLegacyPageIdV2(input.boardId);
  return {
    schemaVersion: 2,
    defaultPageId: pageId,
    pages: [{ pageId, title: '', displayMode: 'fit-page', scene: input.scene }],
  };
};

type SnapshotForArtifactTraversal =
  | {
      boardId: BoardId;
      revision: { revisionId: RevisionId };
      scene: SceneV1;
      artifacts: ReadonlyArray<{ artifact: ArtifactReferenceV1 }>;
    }
  | {
      boardId: BoardId;
      revision: { revisionId: RevisionId };
      document: BoardDocument;
      artifacts: ReadonlyArray<{ artifact: ArtifactReferenceV1 }>;
    };

export type SnapshotArtifactReferenceV2 = Readonly<{
  boardId: BoardId;
  revisionId: RevisionId;
  firstPageId: PageId;
  artifactId: ArtifactReferenceV1['artifactId'];
  versionId: ArtifactReferenceV1['versionId'];
  ordinal: number;
}>;

const artifactKey = (artifact: ArtifactReferenceV1): string =>
  `${artifact.artifactId}\0${artifact.versionId}`;

export const collectArtifactReferencesAcrossSnapshotV2 = (input: {
  boardId: z.infer<typeof BoardIdSchemaV1>;
  revisionId: z.infer<typeof RevisionIdSchemaV1>;
  snapshot: SnapshotForArtifactTraversal;
}): readonly SnapshotArtifactReferenceV2[] => {
  if (
    input.boardId !== input.snapshot.boardId ||
    input.revisionId !== input.snapshot.revision.revisionId
  )
    throw new TypeError('snapshot identity does not match traversal input');

  const document =
    'document' in input.snapshot
      ? input.snapshot.document
      : adaptLegacySceneToDocumentV2({
          boardId: input.snapshot.boardId,
          scene: input.snapshot.scene,
        });
  const inventory = new Map<string, number>();
  input.snapshot.artifacts.forEach(({ artifact }) => {
    const key = artifactKey(artifact);
    inventory.set(key, (inventory.get(key) ?? 0) + 1);
  });

  const output: SnapshotArtifactReferenceV2[] = [];
  const seen = new Set<string>();
  for (const item of collectDocumentNodesV2(document)) {
    if (item.node.type !== 'content.artifact') continue;
    const key = artifactKey(item.node.artifact);
    if (seen.has(key)) continue;
    if (inventory.get(key) !== 1)
      throw new TypeError('artifact reference does not have exactly one inventory entry');
    seen.add(key);
    output.push({
      boardId: input.boardId,
      revisionId: input.revisionId,
      firstPageId: item.page.pageId,
      artifactId: item.node.artifact.artifactId,
      versionId: item.node.artifact.versionId,
      ordinal: output.length + 1,
    });
  }
  return output;
};
