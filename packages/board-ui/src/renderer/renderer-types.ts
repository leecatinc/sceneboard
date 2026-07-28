import type { ReactNode } from 'react';
import type {
  BoardNodeV1,
  BoardPageV2,
  BoardSnapshot,
  NodeTypeV1,
  PageId,
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

export type RendererContextV2 = PageRendererContextV2 & {
  selectedTabs: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  renderHitl?: RendererComponentV1<'content.hitl'>;
  drawingView?: DrawingViewControllerV1;
};

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
  emptyLabel?: string;
};
