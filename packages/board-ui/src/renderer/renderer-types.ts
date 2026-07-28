import type { ReactNode } from 'react';
import type {
  ArtifactReferenceV1,
  BoardNodeV1,
  BoardPageV2,
  BoardSnapshot,
  MediaId,
  NodeTypeV1,
  PageId,
  PublicArtifactSummaryV1,
  PublicMediaResourceV1,
  RevisionId,
} from '@sceneboard/board-schema';
import type { ArtifactViewModeV1 } from '../artifact/ports.js';

export type DrawingViewStateV1 = Readonly<{
  nodeId: string;
  scale: number | null;
  canReset: boolean;
}>;

export type DrawingViewControllerV1 = Readonly<{
  mode: ArtifactViewModeV1;
  resetSignal: number;
  onStateChange: (state: DrawingViewStateV1) => void;
  onCaptureActiveChange?: (active: boolean) => void;
}>;

export type MediaResolverMetadataV1 = Readonly<{
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  etag: string;
}>;

export type MediaResolverV1 = (
  input: Readonly<{
    mediaId: MediaId;
    boardId: BoardSnapshot['boardId'];
    revisionId: RevisionId;
    pageId: PageId;
  }>,
) =>
  | Readonly<{ url: string; metadata?: MediaResolverMetadataV1 }>
  | Readonly<{ error: 'unavailable' }>;

export type PageRendererContextV2 = Readonly<{
  protocolVersion: 1;
  boardId: BoardSnapshot['boardId'];
  revision: BoardSnapshot['revision'];
  hitl: BoardSnapshot['hitl'];
  artifacts: BoardSnapshot['artifacts'];
  capabilities: BoardSnapshot['capabilities'];
  lastEventSequence: number;
  documentSchemaVersion: 1 | 2;
  selectedPageId: PageId;
}>;

export type SceneRendererContextV1 = Readonly<{
  boardId: BoardSnapshot['boardId'];
  revisionId: RevisionId;
  selectedPageId: PageId;
  artifacts: ReadonlyArray<{
    artifact: ArtifactReferenceV1;
    status: string;
  }>;
  hitl: BoardSnapshot['hitl'];
  selectedTabs: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  renderHitl?: RendererComponentV1<'content.hitl'>;
  drawingView?: DrawingViewControllerV1;
  mediaResolver?: MediaResolverV1;
}>;

export type RendererContextV2 = PageRendererContextV2 &
  Omit<
    SceneRendererContextV1,
    'boardId' | 'selectedPageId' | 'artifacts' | 'hitl' | 'revisionId'
  > & {
    revisionId: RevisionId;
  };

export type PublicPageRendererContextV1 = Readonly<{
  surface: 'public-share';
  boardId: BoardSnapshot['boardId'];
  revisionId: BoardSnapshot['revision']['revisionId'];
  publicationGeneration: number;
  accessGeneration: number;
  artifacts: readonly PublicArtifactSummaryV1[];
  media: readonly PublicMediaResourceV1[];
  selectedPageId: PageId;
}>;

export type RenderNodeV1 = (node: BoardNodeV1) => ReactNode;

export type RendererComponentV1<K extends NodeTypeV1 = NodeTypeV1> = (props: {
  node: Extract<BoardNodeV1, { type: K }>;
  context: RendererContextV2;
  renderNode: RenderNodeV1;
}) => ReactNode;

export type BoardRendererPropsV2 = {
  page: BoardPageV2;
  context: PageRendererContextV2;
  selectedTabs?: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  renderHitl?: RendererComponentV1<'content.hitl'>;
  drawingView?: DrawingViewControllerV1;
  mediaResolver?: MediaResolverV1;
  emptyLabel?: string;
};

export type PublicBoardRendererPropsV1 = {
  page: BoardPageV2;
  context: PublicPageRendererContextV1;
  selectedTabs?: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  drawingView?: DrawingViewControllerV1;
  mediaResolver?: MediaResolverV1;
  emptyLabel?: string;
};
