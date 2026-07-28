import {
  MediaAltSchemaV1,
  MediaCaptionSchemaV1,
  type BoardDocumentV2,
  type ImageNodeV1,
  type MediaId,
  type NodeId,
  type PageId,
} from '@sceneboard/board-schema';
import type { MediaImagePlacementV1 } from '@sceneboard/board-sdk/document-transform';
import {
  visibleCanvasRectV1,
  type PageCanvasTransformV1,
  type PageRectV1,
} from './page-display-mode.types';

export type ImageAuthoringInputV1 =
  | Readonly<{ decorative: true; alt: ''; fit: 'contain' | 'cover' | 'fill' | 'none' }>
  | Readonly<{
      decorative: false;
      alt: string;
      caption?: string;
      fit: 'contain' | 'cover' | 'fill' | 'none';
    }>;

export type ImageAuthoringPhaseV1 =
  | 'idle'
  | 'hashing'
  | 'uploading'
  | 'upload-uncertain'
  | 'authoring'
  | 'placing'
  | 'placement-conflict'
  | 'success'
  | 'failure';

export const createMediaImageNodeV1 = (input: {
  nodeId: NodeId;
  mediaId: MediaId;
  authoring: ImageAuthoringInputV1;
}): ImageNodeV1 | null => {
  if (input.authoring.decorative)
    return {
      id: input.nodeId,
      type: 'content.image',
      source: { type: 'media', mediaId: input.mediaId },
      decorative: true,
      alt: '',
      fit: input.authoring.fit,
    };
  const alt = MediaAltSchemaV1.safeParse(input.authoring.alt);
  const caption =
    input.authoring.caption === undefined
      ? null
      : MediaCaptionSchemaV1.safeParse(input.authoring.caption);
  if (!alt.success || (caption !== null && !caption.success)) return null;
  return {
    id: input.nodeId,
    type: 'content.image',
    source: { type: 'media', mediaId: input.mediaId },
    decorative: false,
    alt: alt.data,
    ...(caption === null ? {} : { caption: caption.data }),
    fit: input.authoring.fit,
  };
};

export const chooseMediaImagePlacementV1 = (input: {
  document: BoardDocumentV2;
  pageId: PageId;
  wrapperNodeId: NodeId;
  intrinsicWidth: number;
  intrinsicHeight: number;
  canvasViewport?: Readonly<{
    transform: PageCanvasTransformV1;
    pageViewportRect: PageRectV1;
    scrollTop: number;
  }> | null;
}): MediaImagePlacementV1 | null => {
  const page = input.document.pages.find(({ pageId }) => pageId === input.pageId);
  if (page === undefined) return null;
  const root = page.scene.root;
  if (root?.type !== 'layout.canvas')
    return { kind: 'page-end', wrapperNodeId: input.wrapperNodeId };
  if (
    !Number.isFinite(input.intrinsicWidth) ||
    !Number.isFinite(input.intrinsicHeight) ||
    input.intrinsicWidth <= 0 ||
    input.intrinsicHeight <= 0
  )
    return null;
  if (input.canvasViewport == null) return null;
  const visible = visibleCanvasRectV1(
    input.canvasViewport.transform,
    input.canvasViewport.pageViewportRect,
    input.canvasViewport.scrollTop,
  );
  if (visible.width <= 0 || visible.height <= 0) return null;
  let scale = Math.min(
    640 / input.intrinsicWidth,
    visible.width / input.intrinsicWidth,
    visible.height / input.intrinsicHeight,
    root.width / input.intrinsicWidth,
    root.height / input.intrinsicHeight,
  );
  let width = input.intrinsicWidth * scale;
  let height = input.intrinsicHeight * scale;
  if (
    (width < 44 || height < 44) &&
    visible.width >= 44 &&
    visible.height >= 44 &&
    root.width >= 44 &&
    root.height >= 44
  ) {
    const minimumScale = Math.max(44 / input.intrinsicWidth, 44 / input.intrinsicHeight);
    if (
      input.intrinsicWidth * minimumScale > Math.min(640, visible.width, root.width) ||
      input.intrinsicHeight * minimumScale > Math.min(visible.height, root.height)
    )
      return null;
    scale = Math.max(scale, minimumScale);
    width = input.intrinsicWidth * scale;
    height = input.intrinsicHeight * scale;
  }
  if (width <= 0 || height <= 0) return null;
  const maximumZ = root.children.reduce((value, child) => Math.max(value, child.zIndex), -1);
  if (!Number.isSafeInteger(maximumZ) || maximumZ === Number.MAX_SAFE_INTEGER) return null;
  return {
    kind: 'canvas',
    x: Math.max(0, Math.min(root.width - width, visible.x + (visible.width - width) / 2)),
    y: Math.max(0, Math.min(root.height - height, visible.y + (visible.height - height) / 2)),
    width,
    height,
    zIndex: maximumZ + 1,
  };
};

const sameImage = (left: ImageNodeV1, right: ImageNodeV1): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const mediaImageProjectionV1 = (input: {
  document: BoardDocumentV2;
  pageId: PageId;
  image: ImageNodeV1;
  placement: MediaImagePlacementV1;
}): 'exact' | 'absent' | 'collision' => {
  const page = input.document.pages.find(({ pageId }) => pageId === input.pageId);
  if (page === undefined) return 'collision';
  const root = page.scene.root;
  if (root === null) return 'absent';
  if (input.placement.kind === 'canvas') {
    if (root.type !== 'layout.canvas') return 'collision';
    const child = root.children.find(({ node }) => node.id === input.image.id);
    if (child === undefined) return 'absent';
    return sameImage(child.node as ImageNodeV1, input.image) &&
      child.x === input.placement.x &&
      child.y === input.placement.y &&
      child.width === input.placement.width &&
      child.height === input.placement.height &&
      child.zIndex === input.placement.zIndex
      ? 'exact'
      : 'collision';
  }
  if (root.id === input.image.id)
    return root.type === 'content.image' && sameImage(root, input.image) ? 'exact' : 'collision';
  if (root.type !== 'layout.split' || root.direction !== 'vertical') {
    const contains = JSON.stringify(root).includes(`"id":"${input.image.id}"`);
    return contains ? 'collision' : 'absent';
  }
  const matches = root.children.filter(({ node }) => node.id === input.image.id);
  if (matches.length === 0) return 'absent';
  const last = root.children.at(-1);
  return matches.length === 1 &&
    last?.node.id === input.image.id &&
    last.weight === 1 &&
    sameImage(last.node as ImageNodeV1, input.image)
    ? 'exact'
    : 'collision';
};
