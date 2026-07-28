'use client';

import type { BoardNodeV1, BoardPageV2 } from '@sceneboard/board-schema';

import { inspectRenderBudgetV1 } from './render-budget.js';
import { RendererErrorBoundary } from './RendererErrorBoundary.js';
import { RENDERER_REGISTRY_V1 } from './renderer-registry.js';
import type {
  DrawingViewControllerV1,
  RendererContextV2,
  SceneRendererContextV1,
} from './renderer-types.js';

export function RenderSceneTree({
  page,
  context,
  rootContext,
  drawingView,
  emptyLabel,
}: {
  page: BoardPageV2;
  context: SceneRendererContextV1;
  rootContext: SceneRendererContextV1;
  drawingView?: DrawingViewControllerV1;
  emptyLabel: string;
}) {
  const budget = inspectRenderBudgetV1(page.scene.root);
  if (!budget.ok)
    return (
      <section className="scene-fallback" role="alert">
        {context.selectedPageId}: The scene exceeds the safe render budget.
      </section>
    );
  if (page.scene.root === null) return <section className="scene-empty">{emptyLabel}</section>;
  const renderNode = (node: BoardNodeV1) => {
    const Renderer = RENDERER_REGISTRY_V1[node.type];
    const nodeContext =
      node.id === page.scene.root?.id || drawingView === undefined ? rootContext : context;
    return (
      <RendererErrorBoundary
        key={node.id}
        nodeId={`${context.selectedPageId}:${node.id}`}
        nodeType={node.type}
      >
        <Renderer
          node={node as never}
          context={nodeContext as RendererContextV2}
          renderNode={renderNode}
        />
      </RendererErrorBoundary>
    );
  };
  return <div className="scene-root">{renderNode(page.scene.root)}</div>;
}
