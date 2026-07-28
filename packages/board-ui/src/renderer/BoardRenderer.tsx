'use client';

import type { BoardNodeV1 } from '@sceneboard/board-schema';

import { inspectRenderBudgetV1 } from './render-budget.js';
import { RendererErrorBoundary } from './RendererErrorBoundary.js';
import { RENDERER_REGISTRY_V1 } from './renderer-registry.js';
import type { BoardRendererPropsV2, RendererContextV2 } from './renderer-types.js';

export function BoardRenderer({
  page,
  context: inputContext,
  selectedTabs = {},
  onSelectTab,
  renderArtifact,
  renderHitl,
  drawingView,
  emptyLabel = 'This scene is empty.',
}: BoardRendererPropsV2) {
  const budget = inspectRenderBudgetV1(page.scene.root);
  if (!budget.ok)
    return (
      <section className="scene-fallback" role="alert">
        {inputContext.selectedPageId}: The scene exceeds the safe render budget.
      </section>
    );
  if (page.scene.root === null) return <section className="scene-empty">{emptyLabel}</section>;
  const sharedContext: RendererContextV2 = {
    ...inputContext,
    selectedTabs,
    ...(onSelectTab === undefined ? {} : { onSelectTab }),
    ...(renderArtifact === undefined ? {} : { renderArtifact }),
    ...(renderHitl === undefined ? {} : { renderHitl }),
  };
  const context: RendererContextV2 =
    drawingView === undefined ? sharedContext : { ...sharedContext, drawingView };
  const renderNode = (node: BoardNodeV1) => {
    const Renderer = RENDERER_REGISTRY_V1[node.type];
    const nodeContext =
      node.id === page.scene.root?.id || drawingView === undefined ? context : sharedContext;
    return (
      <RendererErrorBoundary
        key={node.id}
        nodeId={`${inputContext.selectedPageId}:${node.id}`}
        nodeType={node.type}
      >
        <Renderer node={node as never} context={nodeContext} renderNode={renderNode} />
      </RendererErrorBoundary>
    );
  };
  return <div className="scene-root">{renderNode(page.scene.root)}</div>;
}
