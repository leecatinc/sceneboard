'use client';

import { NodeIdParserV1 } from '@sceneboard/board-schema';
import { useCallback, useEffect, useRef } from 'react';

import type {
  ArtifactNavigationIntentV1,
  ArtifactResizeRequestV1,
} from '@sceneboard/artifact-runtime/bridge';

import {
  ARTIFACT_BASE_HEIGHT,
  ARTIFACT_BASE_WIDTH,
  centerArtifactViewV1,
  fitArtifactViewV1,
  mapArtifactAnchorV1,
  panArtifactViewByInnerDeltaV1,
  resolveArtifactFitRenderScaleV1,
  sizeArtifactStageV1,
  zoomArtifactViewV1,
  type ArtifactViewTransformV1,
} from './artifact-view-transform.js';
import {
  admitArtifactResizeRequestV1,
  advanceArtifactResetEpochV1,
  applyArtifactPanIntentV1,
  changesArtifactSizeV1,
  createArtifactResizeQueueV1,
  takePendingArtifactResizeV1,
} from './artifact-host-state.js';
import type { ArtifactHostInputV1 } from './ports.js';
import { ArtifactFallback } from './ArtifactFallback.js';
import { useArtifactBridgeV1 } from './use-artifact-bridge.js';

function AdmittedArtifactHost(input: ArtifactHostInputV1) {
  const containerElementRef = useRef<HTMLDivElement | null>(null);
  const baseSizeRef = useRef({ width: ARTIFACT_BASE_WIDTH, height: ARTIFACT_BASE_HEIGHT });
  const transformRef = useRef<ArtifactViewTransformV1>({ scale: 1, x: 0, y: 0 });
  const hasInteractedRef = useRef(false);
  const isRegisteredRef = useRef(false);
  const isPanningRef = useRef(false);
  const captureSourcesRef = useRef(new Set<string>());
  const resizeQueueRef = useRef(createArtifactResizeQueueV1());
  const sizeFrameRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const appliedResetEpochRef = useRef(0);
  const renderModeRef = useRef<ArtifactResizeRequestV1['renderMode']>(undefined);
  const priorModeRef = useRef(input.viewMode ?? 'fit-page');
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  const setCaptureSource = useCallback((source: string, active: boolean) => {
    const sources = captureSourcesRef.current;
    const wasActive = sources.size > 0;
    if (active) sources.add(source);
    else sources.delete(source);
    const isActive = sources.size > 0;
    if (wasActive === isActive) return;
    try {
      latestInputRef.current.onCaptureActiveChange?.(isActive);
    } catch {
      return;
    }
  }, []);

  const emitViewState = useCallback(
    (phase: 'register' | 'interaction' | 'unregister', scale: number) => {
      const current = latestInputRef.current;
      if (!Number.isFinite(scale) || scale < 0.1 || scale > 4) return;
      try {
        current.onViewStateChange?.({
          hostInstanceId: current.hostInstanceId,
          incarnationKey: current.incarnationKey,
          phase,
          scale,
        });
      } catch {
        return;
      }
    },
    [],
  );

  const writeTransform = useCallback(
    (next: ArtifactViewTransformV1, renderedScale = next.scale) => {
      const container = containerElementRef.current;
      const transformPlane = container?.querySelector<HTMLElement>('.artifact-runtime-transform');
      if (container === null || transformPlane === null || transformPlane === undefined) return;
      transformRef.current = next;
      transformPlane.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${renderedScale})`;
      container.dataset.zoomPercent = String(Math.round(next.scale * 100));
    },
    [],
  );

  const applyLayout = useCallback(
    (resetActual = false) => {
      const container = containerElementRef.current;
      const stage = container?.querySelector<HTMLElement>('.artifact-runtime-stage');
      const transformPlane = stage?.querySelector<HTMLElement>('.artifact-runtime-transform');
      const frame = transformPlane?.querySelector<HTMLIFrameElement>('.artifact-runtime-frame');
      if (
        container === null ||
        stage === null ||
        stage === undefined ||
        transformPlane === null ||
        transformPlane === undefined ||
        frame === null ||
        frame === undefined
      )
        return;
      const availableWidth = Math.max(1, container.clientWidth);
      const availableHeight = Math.max(1, container.clientHeight);
      const size = baseSizeRef.current;
      const mode = latestInputRef.current.viewMode ?? 'fit-page';
      frame.style.transform = 'none';
      frame.style.setProperty('zoom', '1');
      container.dataset.viewMode = mode;
      if (mode === 'actual') {
        frame.style.width = `${size.width}px`;
        frame.style.height = `${size.height}px`;
        transformPlane.style.width = `${size.width}px`;
        transformPlane.style.height = `${size.height}px`;
        const next =
          resetActual || !hasInteractedRef.current
            ? centerArtifactViewV1({
                availableWidth,
                availableHeight,
                contentWidth: size.width,
                contentHeight: size.height,
              })
            : transformRef.current;
        const stageSize = sizeArtifactStageV1({
          mode,
          availableWidth,
          availableHeight,
          contentWidth: size.width,
          contentHeight: size.height,
          scale: next.scale,
        });
        stage.style.width = `${stageSize.width}px`;
        stage.style.height = `${stageSize.height}px`;
        writeTransform(next);
        return;
      }
      const next = fitArtifactViewV1({
        mode,
        availableWidth,
        availableHeight,
        contentWidth: size.width,
        contentHeight: size.height,
      });
      const renderScale = resolveArtifactFitRenderScaleV1({
        visualScale: next.scale,
        responsiveFixedCanvas: renderModeRef.current === 'responsive-fixed-canvas',
      });
      const viewportWidth = size.width * renderScale.viewportScale;
      const viewportHeight = size.height * renderScale.viewportScale;
      frame.style.width = `${viewportWidth}px`;
      frame.style.height = `${viewportHeight}px`;
      transformPlane.style.width = `${viewportWidth}px`;
      transformPlane.style.height = `${viewportHeight}px`;
      const stageSize = sizeArtifactStageV1({
        mode,
        availableWidth,
        availableHeight,
        contentWidth: size.width,
        contentHeight: size.height,
        scale: next.scale,
      });
      stage.style.width = `${stageSize.width}px`;
      stage.style.height = `${stageSize.height}px`;
      writeTransform(next, renderScale.compositorScale);
    },
    [writeTransform],
  );

  const applyResizeRequest = useCallback(
    (request: ArtifactResizeRequestV1) => {
      const admission = admitArtifactResizeRequestV1(resizeQueueRef.current, request);
      resizeQueueRef.current = admission.state;
      if (!admission.accepted) return;
      if (sizeFrameRef.current !== null) return;
      const generation = generationRef.current;
      sizeFrameRef.current = requestAnimationFrame(() => {
        sizeFrameRef.current = null;
        if (generation !== generationRef.current) return;
        const taken = takePendingArtifactResizeV1(resizeQueueRef.current);
        resizeQueueRef.current = taken.state;
        const pending = taken.pending;
        if (pending === null) return;
        const renderModeChanged = renderModeRef.current !== pending.renderMode;
        renderModeRef.current = pending.renderMode;
        const current = baseSizeRef.current;
        if (!renderModeChanged && !changesArtifactSizeV1(current, pending)) return;
        baseSizeRef.current = { width: pending.width, height: pending.height };
        applyLayout(
          !hasInteractedRef.current && (latestInputRef.current.viewMode ?? 'fit-page') === 'actual',
        );
      });
    },
    [applyLayout],
  );

  const onResizeRequest = useCallback(
    (request: ArtifactResizeRequestV1) => {
      applyResizeRequest(request);
      try {
        latestInputRef.current.onResizeRequest?.(request);
      } catch {
        return;
      }
    },
    [applyResizeRequest],
  );

  const applyNavigationIntent = useCallback(
    (intent: ArtifactNavigationIntentV1) => {
      if ((latestInputRef.current.viewMode ?? 'fit-page') !== 'actual') return;
      const container = containerElementRef.current;
      const frame = container?.querySelector<HTMLIFrameElement>('.artifact-runtime-frame');
      if (container === null || frame === null || frame === undefined) return;
      if (intent.type === 'artifact.navigation.wheel') {
        const containerRect = container.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const anchor = mapArtifactAnchorV1({
          xMillionth: intent.xMillionth,
          yMillionth: intent.yMillionth,
          containerLeft: containerRect.left,
          containerTop: containerRect.top,
          frameLeft: frameRect.left,
          frameTop: frameRect.top,
          frameWidth: frameRect.width,
          frameHeight: frameRect.height,
        });
        if (anchor === null) return;
        hasInteractedRef.current = true;
        const next = zoomArtifactViewV1({
          transform: transformRef.current,
          pointerX: anchor.x,
          pointerY: anchor.y,
          deltaY: intent.deltaY,
        });
        writeTransform(next);
        emitViewState('interaction', next.scale);
        return;
      }
      const pan = applyArtifactPanIntentV1(isPanningRef.current, intent);
      if (intent.type === 'artifact.navigation.pan.start') {
        isPanningRef.current = pan.panning;
        setCaptureSource('bridge-pan', true);
        hasInteractedRef.current = true;
        container.dataset.panning = 'true';
        emitViewState('interaction', transformRef.current.scale);
        return;
      }
      if (
        pan.shouldMove &&
        (intent.type === 'artifact.navigation.pan.move' ||
          intent.type === 'artifact.navigation.pan.end')
      ) {
        const next = panArtifactViewByInnerDeltaV1(
          transformRef.current,
          intent.deltaX,
          intent.deltaY,
        );
        writeTransform(next);
        if (intent.type === 'artifact.navigation.pan.end') {
          isPanningRef.current = pan.panning;
          setCaptureSource('bridge-pan', false);
          delete container.dataset.panning;
        }
        return;
      }
      if (intent.type === 'artifact.navigation.pan.cancel') {
        isPanningRef.current = pan.panning;
        setCaptureSource('bridge-pan', false);
        delete container.dataset.panning;
      }
    },
    [emitViewState, setCaptureSource, writeTransform],
  );

  const onNavigationIntent = useCallback(
    (intent: ArtifactNavigationIntentV1) => {
      applyNavigationIntent(intent);
      try {
        latestInputRef.current.onNavigationIntent?.(intent);
      } catch {
        return;
      }
    },
    [applyNavigationIntent],
  );

  const resetCanvasState = useCallback(() => {
    generationRef.current += 1;
    if (sizeFrameRef.current !== null) cancelAnimationFrame(sizeFrameRef.current);
    sizeFrameRef.current = null;
    resizeQueueRef.current = createArtifactResizeQueueV1();
    baseSizeRef.current = { width: ARTIFACT_BASE_WIDTH, height: ARTIFACT_BASE_HEIGHT };
    renderModeRef.current = undefined;
    transformRef.current = { scale: 1, x: 0, y: 0 };
    hasInteractedRef.current = false;
    isPanningRef.current = false;
    captureSourcesRef.current.clear();
    const reset = advanceArtifactResetEpochV1(appliedResetEpochRef.current, latestInputRef.current);
    appliedResetEpochRef.current = reset.epoch;
    const container = containerElementRef.current;
    if (container !== null) {
      delete container.dataset.panning;
      delete container.dataset.viewMode;
      delete container.dataset.zoomPercent;
      container.scrollLeft = 0;
      container.scrollTop = 0;
      container.replaceChildren();
    }
    try {
      latestInputRef.current.onCaptureActiveChange?.(false);
    } catch {
      return;
    }
  }, []);

  const bridge = useArtifactBridgeV1({
    ...input,
    viewMode: input.viewMode ?? 'fit-page',
    onNavigationIntent,
    onResizeRequest,
  });
  const stopArtifact = bridge.stop;
  containerElementRef.current = bridge.containerRef.current;
  const stopSignal = input.stopSignal ?? 0;
  const priorStopSignal = useRef(stopSignal);

  useEffect(() => {
    containerElementRef.current = bridge.containerRef.current;
    const container = bridge.containerRef.current;
    if (container === null || bridge.phase !== 'active') return undefined;
    const nextMode = input.viewMode ?? 'fit-page';
    const modeChanged = priorModeRef.current !== nextMode;
    if (modeChanged) {
      container.scrollLeft = 0;
      container.scrollTop = 0;
      hasInteractedRef.current = false;
      isPanningRef.current = false;
      delete container.dataset.panning;
      priorModeRef.current = nextMode;
    }
    applyLayout(modeChanged && nextMode === 'actual');
    const observer = new ResizeObserver(() => applyLayout(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyLayout, bridge.containerRef, bridge.phase, input.viewMode]);

  useEffect(() => {
    if (
      bridge.phase === 'stopped' ||
      bridge.phase === 'blocked' ||
      bridge.phase === 'failed' ||
      bridge.phase === 'unsupported'
    )
      resetCanvasState();
  }, [bridge.phase, resetCanvasState]);

  useEffect(() => {
    const isActiveActual = bridge.phase === 'active' && (input.viewMode ?? 'fit-page') === 'actual';
    if (isActiveActual && !isRegisteredRef.current) {
      isRegisteredRef.current = true;
      emitViewState('register', transformRef.current.scale);
    } else if (!isActiveActual && isRegisteredRef.current) {
      isRegisteredRef.current = false;
      emitViewState('unregister', transformRef.current.scale);
    }
    return () => {
      if (isRegisteredRef.current) {
        isRegisteredRef.current = false;
        emitViewState('unregister', transformRef.current.scale);
      }
    };
  }, [bridge.phase, emitViewState, input.viewMode]);

  useEffect(() => {
    const reset = advanceArtifactResetEpochV1(appliedResetEpochRef.current, latestInputRef.current);
    if (!reset.advanced || bridge.phase !== 'active' || (input.viewMode ?? 'fit-page') !== 'actual')
      return;
    appliedResetEpochRef.current = reset.epoch;
    hasInteractedRef.current = false;
    applyLayout(true);
    emitViewState('interaction', 1);
  }, [
    applyLayout,
    bridge.phase,
    emitViewState,
    input.hostInstanceId,
    input.incarnationKey,
    input.resetCommand,
    input.viewMode,
  ]);

  useEffect(() => {
    if (priorStopSignal.current === stopSignal) return;
    priorStopSignal.current = stopSignal;
    stopArtifact();
  }, [stopArtifact, stopSignal]);

  useEffect(() => () => resetCanvasState(), [input.incarnationKey, resetCanvasState]);

  return (
    <section
      className={`artifact-host artifact-${bridge.phase}`}
      aria-label="Isolated artifact"
      data-artifact-capture
    >
      <div
        ref={bridge.containerRef}
        className="artifact-frame-container"
        aria-hidden={bridge.phase !== 'active'}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setCaptureSource(`pointer:${event.pointerId}`, true);
        }}
        onPointerUp={(event) => {
          setCaptureSource(`pointer:${event.pointerId}`, false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => setCaptureSource(`pointer:${event.pointerId}`, false)}
        onLostPointerCapture={(event) => setCaptureSource(`pointer:${event.pointerId}`, false)}
      />
      {bridge.phase === 'active' ? null : (
        <ArtifactFallback phase={bridge.phase} correlationId={bridge.correlationId} />
      )}
      {(input.showStopControl ?? true) &&
        (bridge.phase === 'loading' ||
          bridge.phase === 'handshaking' ||
          bridge.phase === 'active') && (
          <button type="button" className="artifact-stop" onClick={bridge.stop}>
            Stop rendering
          </button>
        )}
    </section>
  );
}

export function ArtifactHost(input: ArtifactHostInputV1) {
  const expectedIncarnation = `${input.routeEpoch}:${input.hostInstanceId}:${input.artifact.artifactId}:${input.artifact.versionId}`;
  const hasValidIdentity =
    NodeIdParserV1.parse(input.hostInstanceId).ok && input.incarnationKey === expectedIncarnation;
  if (!hasValidIdentity) {
    return (
      <section
        className="artifact-host artifact-failed"
        aria-label="Isolated artifact"
        data-artifact-capture
      >
        <div className="artifact-frame-container" aria-hidden="true" />
        <ArtifactFallback phase="failed" correlationId={null} />
      </section>
    );
  }
  return <AdmittedArtifactHost {...input} />;
}
