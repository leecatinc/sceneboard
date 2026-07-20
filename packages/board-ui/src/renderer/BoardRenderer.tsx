'use client';

import { BoardSnapshotParserV1, type BoardNodeV1 } from '@leecat-board/board-schema';

import { inspectRenderBudgetV1 } from './render-budget.js';
import { RendererErrorBoundary } from './RendererErrorBoundary.js';
import { RENDERER_REGISTRY_V1 } from './renderer-registry.js';
import type { BoardRendererPropsV1, RendererContextV1 } from './renderer-types.js';

export function BoardRenderer({
  snapshot: input,
  selectedTabs = {},
  onSelectTab,
  renderArtifact,
  renderHitl,
  drawingView,
  emptyLabel = 'This scene is empty.',
}: BoardRendererPropsV1) {
  const parsed = BoardSnapshotParserV1.parse(input);
  if (!parsed.ok) return <section className="scene-fallback" role="alert">The scene could not be verified.</section>;
  const snapshot = parsed.data.value;
  const budget = inspectRenderBudgetV1(snapshot.scene.root);
  if (!budget.ok) return <section className="scene-fallback" role="alert">The scene exceeds the safe render budget.</section>;
  if (snapshot.scene.root === null) return <section className="scene-empty">{emptyLabel}</section>;
  const context: RendererContextV1 = {
    snapshot,
    selectedTabs,
    ...(onSelectTab === undefined ? {} : { onSelectTab }),
    ...(renderArtifact === undefined ? {} : { renderArtifact }),
    ...(renderHitl === undefined ? {} : { renderHitl }),
    ...(drawingView === undefined ? {} : { drawingView }),
  };
  const renderNode = (node: BoardNodeV1) => {
    const Renderer = RENDERER_REGISTRY_V1[node.type];
    return (
      <RendererErrorBoundary key={node.id} nodeId={node.id} nodeType={node.type}>
        <Renderer node={node as never} context={context} renderNode={renderNode} />
      </RendererErrorBoundary>
    );
  };
  return <div className="scene-root">{renderNode(snapshot.scene.root)}</div>;
}
