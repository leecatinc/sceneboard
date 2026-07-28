'use client';

import React, { useLayoutEffect, useRef } from 'react';

import { RenderSceneTree } from './RenderSceneTree.js';
import { waitForPublicRenderReadyV1 } from './render-readiness.js';
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
  renderEpoch,
  onRenderReady,
}: PublicBoardRendererPropsV1) {
  const rootRef = useRef<HTMLDivElement>(null);
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
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || onRenderReady === undefined || renderEpoch === undefined) return;
    return waitForPublicRenderReadyV1(root, () =>
      onRenderReady({
        boardId: inputContext.boardId,
        revisionId: inputContext.revisionId,
        pageId: inputContext.selectedPageId,
        renderEpoch,
      }),
    );
  }, [
    inputContext.boardId,
    inputContext.revisionId,
    inputContext.selectedPageId,
    onRenderReady,
    renderEpoch,
  ]);
  return (
    <div ref={rootRef} data-public-render-epoch={renderEpoch}>
      <RenderSceneTree
        page={page}
        context={sharedContext}
        rootContext={rootContext}
        {...(drawingView === undefined ? {} : { drawingView })}
        {...(mediaResolver === undefined ? {} : { mediaResolver })}
        emptyLabel={emptyLabel}
      />
    </div>
  );
}
