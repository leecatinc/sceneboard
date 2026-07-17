import type { ReactNode } from 'react';
import type {
  BoardNodeV1,
  BoardSnapshotV1,
  NodeTypeV1,
} from '@leecat-board/board-schema';

export type RendererContextV1 = {
  snapshot: BoardSnapshotV1;
  selectedTabs: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  renderHitl?: RendererComponentV1<'content.hitl'>;
};

export type RenderNodeV1 = (node: BoardNodeV1) => ReactNode;

export type RendererComponentV1<K extends NodeTypeV1 = NodeTypeV1> = (
  props: {
    node: Extract<BoardNodeV1, { type: K }>;
    context: RendererContextV1;
    renderNode: RenderNodeV1;
  },
) => ReactNode;

export type BoardRendererPropsV1 = {
  snapshot: BoardSnapshotV1;
  selectedTabs?: Readonly<Record<string, string>>;
  onSelectTab?: (nodeId: string, tabId: string) => void;
  renderArtifact?: RendererComponentV1<'content.artifact'>;
  renderHitl?: RendererComponentV1<'content.hitl'>;
  emptyLabel?: string;
};
