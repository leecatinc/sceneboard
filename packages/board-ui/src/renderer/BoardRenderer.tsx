'use client';

import { RenderSceneTree } from './RenderSceneTree.js';
import type { BoardRendererPropsV2, RendererContextV2 } from './renderer-types.js';

export function BoardRenderer({
  page,
  context: inputContext,
  selectedTabs = {},
  onSelectTab,
  renderArtifact,
  renderHitl,
  drawingView,
  mediaResolver,
  emptyLabel = 'This scene is empty.',
}: BoardRendererPropsV2) {
  const sharedContext: RendererContextV2 = {
    ...inputContext,
    revisionId: inputContext.revision.revisionId,
    selectedTabs,
    ...(onSelectTab === undefined ? {} : { onSelectTab }),
    ...(renderArtifact === undefined ? {} : { renderArtifact }),
    ...(renderHitl === undefined ? {} : { renderHitl }),
  };
  const context: RendererContextV2 =
    drawingView === undefined ? sharedContext : { ...sharedContext, drawingView };
  return (
    <RenderSceneTree
      page={page}
      context={sharedContext}
      rootContext={context}
      {...(drawingView === undefined ? {} : { drawingView })}
      {...(mediaResolver === undefined ? {} : { mediaResolver })}
      emptyLabel={emptyLabel}
    />
  );
}
