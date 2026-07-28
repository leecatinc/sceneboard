'use client';

import { RenderSceneTree } from './RenderSceneTree.js';
import type { PublicBoardRendererPropsV1, SceneRendererContextV1 } from './renderer-types.js';

export function PublicBoardRenderer({
  page,
  context: inputContext,
  selectedTabs = {},
  onSelectTab,
  renderArtifact,
  drawingView,
  mediaResolver,
  emptyLabel = 'This scene is empty.',
}: PublicBoardRendererPropsV1) {
  const sharedContext: SceneRendererContextV1 = {
    boardId: inputContext.boardId,
    revisionId: inputContext.revisionId,
    selectedPageId: inputContext.selectedPageId,
    artifacts: inputContext.artifacts.map((artifact) => ({
      artifact: {
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
      },
      status: artifact.status,
    })),
    hitl: [],
    selectedTabs,
    ...(onSelectTab === undefined ? {} : { onSelectTab }),
    ...(renderArtifact === undefined ? {} : { renderArtifact }),
  };
  const rootContext: SceneRendererContextV1 =
    drawingView === undefined ? sharedContext : { ...sharedContext, drawingView };
  return (
    <RenderSceneTree
      page={page}
      context={sharedContext}
      rootContext={rootContext}
      {...(drawingView === undefined ? {} : { drawingView })}
      {...(mediaResolver === undefined ? {} : { mediaResolver })}
      emptyLabel={emptyLabel}
    />
  );
}
