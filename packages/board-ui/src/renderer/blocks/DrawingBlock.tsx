'use client';

import type { DrawingNodeV1, DrawingStyleV1 } from '@sceneboard/board-schema';
import { useCallback, useEffect, useRef } from 'react';

import {
  centerArtifactViewV1,
  fitArtifactViewV1,
  panArtifactViewV1,
  sizeArtifactStageV1,
  zoomArtifactViewV1,
  type ArtifactViewTransformV1,
} from '../../artifact/artifact-view-transform.js';
import type { DrawingViewControllerV1, RendererComponentV1 } from '../renderer-types.js';

const style = (value: DrawingStyleV1) => ({
  ...(value.stroke === undefined ? {} : { stroke: value.stroke }),
  ...(value.fill === undefined ? { fill: 'none' } : { fill: value.fill }),
  ...(value.strokeWidth === undefined ? {} : { strokeWidth: value.strokeWidth }),
  ...(value.opacity === undefined ? {} : { opacity: value.opacity }),
});

function DrawingSvg({ node }: { node: DrawingNodeV1 }) {
  return (
    <svg
      className="scene-drawing"
      viewBox={`${node.viewBox.x} ${node.viewBox.y} ${node.viewBox.width} ${node.viewBox.height}`}
      role="img"
      aria-label={node.title ?? 'Typed drawing'}
    >
      {node.elements.map((element) => {
        if (element.type === 'path')
          return (
            <polyline
              key={element.id}
              points={element.points.map((point) => `${point.x},${point.y}`).join(' ')}
              {...style(element.style)}
            />
          );
        if (element.type === 'rect')
          return (
            <rect
              key={element.id}
              x={element.x}
              y={element.y}
              width={element.width}
              height={element.height}
              {...style(element.style)}
            />
          );
        if (element.type === 'ellipse')
          return (
            <ellipse
              key={element.id}
              cx={element.cx}
              cy={element.cy}
              rx={element.rx}
              ry={element.ry}
              {...style(element.style)}
            />
          );
        if (element.type === 'line')
          return (
            <line
              key={element.id}
              x1={element.from.x}
              y1={element.from.y}
              x2={element.to.x}
              y2={element.to.y}
              {...style(element.style)}
            />
          );
        return (
          <text key={element.id} x={element.x} y={element.y} {...style(element.style)}>
            {element.text}
          </text>
        );
      })}
    </svg>
  );
}

function StaticDrawingBlock({ node }: { node: DrawingNodeV1 }) {
  return (
    <figure className="scene-block scene-drawing-block">
      <figcaption>{node.title ?? 'Drawing'}</figcaption>
      <DrawingSvg node={node} />
      <p className="visually-hidden">Drawing with {node.elements.length} typed elements.</p>
    </figure>
  );
}

function isResettable(current: ArtifactViewTransformV1, centered: ArtifactViewTransformV1) {
  return (
    Math.abs(current.scale - 1) > 0.000_001 ||
    Math.abs(current.x - centered.x) > 0.5 ||
    Math.abs(current.y - centered.y) > 0.5
  );
}

function InteractiveDrawingBlock({
  node,
  controller,
}: {
  node: DrawingNodeV1;
  controller: DrawingViewControllerV1;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ArtifactViewTransformV1>({ scale: 1, x: 0, y: 0 });
  const centeredRef = useRef<ArtifactViewTransformV1>({ scale: 1, x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panPointRef = useRef({ x: 0, y: 0 });
  const appliedResetSignalRef = useRef(controller.resetSignal);
  const latestControllerRef = useRef(controller);
  latestControllerRef.current = controller;

  const emitState = useCallback(
    (scale: number | null, canReset: boolean) => {
      latestControllerRef.current.onStateChange({ nodeId: node.id, scale, canReset });
    },
    [node.id],
  );

  const writeTransform = useCallback((next: ArtifactViewTransformV1) => {
    const viewport = viewportRef.current;
    const plane = viewport?.querySelector<HTMLElement>('.scene-drawing-transform');
    if (viewport === null || plane === null || plane === undefined) return;
    transformRef.current = next;
    plane.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    viewport.dataset.zoomPercent = String(Math.round(next.scale * 100));
  }, []);

  const applyLayout = useCallback(
    (resetActual = false) => {
      const viewport = viewportRef.current;
      const stage = viewport?.querySelector<HTMLElement>('.scene-drawing-stage');
      const plane = stage?.querySelector<HTMLElement>('.scene-drawing-transform');
      if (
        viewport === null ||
        stage === null ||
        stage === undefined ||
        plane === null ||
        plane === undefined
      )
        return;
      const availableWidth = Math.max(1, viewport.clientWidth);
      const availableHeight = Math.max(1, viewport.clientHeight);
      const contentWidth = node.viewBox.width;
      const contentHeight = node.viewBox.height;
      const mode = latestControllerRef.current.mode;
      plane.style.width = `${contentWidth}px`;
      plane.style.height = `${contentHeight}px`;
      viewport.dataset.viewMode = mode;
      if (mode === 'actual') {
        centeredRef.current = centerArtifactViewV1({
          availableWidth,
          availableHeight,
          contentWidth,
          contentHeight,
        });
        const next = resetActual ? centeredRef.current : transformRef.current;
        const stageSize = sizeArtifactStageV1({
          mode,
          availableWidth,
          availableHeight,
          contentWidth,
          contentHeight,
          scale: next.scale,
        });
        stage.style.width = `${stageSize.width}px`;
        stage.style.height = `${stageSize.height}px`;
        writeTransform(next);
        emitState(next.scale, isResettable(next, centeredRef.current));
        return;
      }
      const next = fitArtifactViewV1({
        mode: mode === 'fill' ? 'fit-page' : mode,
        availableWidth,
        availableHeight,
        contentWidth,
        contentHeight,
      });
      const stageSize = sizeArtifactStageV1({
        mode,
        availableWidth,
        availableHeight,
        contentWidth,
        contentHeight,
        scale: next.scale,
      });
      stage.style.width = `${stageSize.width}px`;
      stage.style.height = `${stageSize.height}px`;
      writeTransform(next);
      emitState(null, false);
    },
    [emitState, node.viewBox.height, node.viewBox.width, writeTransform],
  );

  const applyWheel = useCallback(
    (event: WheelEvent) => {
      if (latestControllerRef.current.mode !== 'actual') return;
      const viewport = viewportRef.current;
      if (viewport === null) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const next = zoomArtifactViewV1({
        transform: transformRef.current,
        pointerX: event.clientX - bounds.left,
        pointerY: event.clientY - bounds.top,
        deltaY: event.deltaY,
      });
      writeTransform(next);
      emitState(next.scale, isResettable(next, centeredRef.current));
    },
    [emitState, writeTransform],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;
    isPanningRef.current = false;
    delete viewport.dataset.panning;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    applyLayout(true);
    const observer = new ResizeObserver(() =>
      applyLayout(
        latestControllerRef.current.mode === 'actual' &&
          !isResettable(transformRef.current, centeredRef.current),
      ),
    );
    observer.observe(viewport);
    viewport.addEventListener('wheel', applyWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('wheel', applyWheel);
    };
  }, [applyLayout, applyWheel, controller.mode]);

  useEffect(() => {
    if (controller.resetSignal <= appliedResetSignalRef.current) return;
    appliedResetSignalRef.current = controller.resetSignal;
    if (controller.mode === 'actual') applyLayout(true);
  }, [applyLayout, controller.mode, controller.resetSignal]);

  useEffect(() => () => emitState(null, false), [emitState]);
  useEffect(() => () => latestControllerRef.current.onCaptureActiveChange?.(false), []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (controller.mode !== 'actual' || event.button !== 1) return;
    event.preventDefault();
    isPanningRef.current = true;
    panPointRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.panning = 'true';
    controller.onCaptureActiveChange?.(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current || controller.mode !== 'actual') return;
    if ((event.buttons & 4) === 0) {
      isPanningRef.current = false;
      delete event.currentTarget.dataset.panning;
      controller.onCaptureActiveChange?.(false);
      return;
    }
    const next = panArtifactViewV1(
      transformRef.current,
      event.clientX - panPointRef.current.x,
      event.clientY - panPointRef.current.y,
    );
    panPointRef.current = { x: event.clientX, y: event.clientY };
    writeTransform(next);
    emitState(next.scale, isResettable(next, centeredRef.current));
  };

  const stopPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    delete event.currentTarget.dataset.panning;
    controller.onCaptureActiveChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <figure className="scene-block scene-drawing-block">
      <figcaption>{node.title ?? 'Drawing'}</figcaption>
      <div
        ref={viewportRef}
        className="scene-drawing-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          if (event.button === 1) stopPanning(event);
        }}
        onPointerCancel={stopPanning}
        onLostPointerCapture={stopPanning}
      >
        <div className="scene-drawing-stage">
          <div className="scene-drawing-transform">
            <DrawingSvg node={node} />
          </div>
        </div>
      </div>
      <p className="visually-hidden">Drawing with {node.elements.length} typed elements.</p>
    </figure>
  );
}

export const DrawingBlock: RendererComponentV1<'content.drawing'> = ({ node, context }) => {
  const controller = context.drawingView;
  return controller === undefined ? (
    <StaticDrawingBlock node={node} />
  ) : (
    <InteractiveDrawingBlock node={node} controller={controller} />
  );
};
