'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  createPageCanvasTransformV1,
  type PageCanvasTransformV1,
  type PageDisplayModeV1,
} from '../../lib/board/page-display-mode.types';
import {
  admitPageMovePointerDownV1,
  classifyPageMoveIntentV1,
  clampPageMoveXV1,
  nextPageMoveXV1,
  pageMoveIsAvailableV1,
} from '../../lib/board/page-move-mode.controller';
import type {
  PageMoveHorizontalSessionV1,
  PageMovePointerStateV1,
} from '../../lib/board/page-move-mode.types';
import { createNestedCanvasFitV1 } from '../../lib/board/page-render-adapter';
import {
  PresentationAnnotationLayer,
  type PresentationAnnotationDeliveryV1,
} from './PresentationAnnotationLayer';
import type { PresentationAnnotationStrokeV1 } from '../../lib/board/presentation-annotation.controller';
import styles from './PresentationStage.module.css';

type CanvasSizeV1 = Readonly<{ width: number; height: number }> | null;
type StagePropertiesV1 = CSSProperties & Readonly<Record<`--${string}`, string | number>>;

const nestedCanvasProperties = [
  '--page-canvas-scale',
  '--page-canvas-origin-x',
  '--page-canvas-move-x',
  '--page-canvas-reserved-width',
  '--page-canvas-reserved-height',
] as const;

const clearNestedCanvasFit = (canvasStage: HTMLElement) => {
  delete canvasStage.dataset.pageNestedCanvasFit;
  for (const property of nestedCanvasProperties) canvasStage.style.removeProperty(property);
};

const canvasDimension = (
  canvasStage: HTMLElement,
  plane: HTMLElement,
  property: '--scene-canvas-width' | '--scene-canvas-height',
) => {
  const declared = Number.parseFloat(canvasStage.style.getPropertyValue(property));
  if (Number.isFinite(declared) && declared > 0) return declared;
  return property === '--scene-canvas-width' ? plane.scrollWidth : plane.scrollHeight;
};

export function PresentationStage({
  stageRef,
  mode,
  canvasSize,
  toolbar,
  overlay,
  annotationToolbarTarget,
  annotationPageKey,
  annotationReadOnly = false,
  annotationStrokes = [],
  onAnnotationStrokesChange,
  presentationActive,
  moveToggle,
  moveIdentity,
  onMoveAvailabilityChange,
  onMoveCaptureActiveChange,
  onCanvasTransformChange,
  children,
  label,
}: {
  stageRef: (element: HTMLDivElement | null) => void;
  mode: PageDisplayModeV1;
  canvasSize: CanvasSizeV1;
  toolbar: ReactNode;
  overlay: ReactNode;
  annotationToolbarTarget?: HTMLElement | null;
  annotationPageKey?: string;
  annotationReadOnly?: boolean;
  annotationStrokes?: readonly PresentationAnnotationStrokeV1[];
  onAnnotationStrokesChange?: (
    strokes: readonly PresentationAnnotationStrokeV1[],
    delivery: PresentationAnnotationDeliveryV1,
  ) => void;
  presentationActive: boolean;
  moveToggle: boolean;
  moveIdentity: string;
  onMoveAvailabilityChange: (available: boolean) => void;
  onMoveCaptureActiveChange: (active: boolean) => void;
  onCanvasTransformChange?: (transform: PageCanvasTransformV1 | null) => void;
  children: ReactNode;
  label: string;
}) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [contentWidth, setContentWidth] = useState(0);
  const [moveX, setMoveX] = useState(0);
  const [navigationHeight, setNavigationHeight] = useState(0);
  const [annotationSurface, setAnnotationSurface] = useState({ width: 1, height: 1 });
  const localStageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const moveXRef = useRef(0);
  const geometryRef = useRef({ viewportWidth: 0, contentWidth: 0 });
  const pointerStateRef = useRef<PageMovePointerStateV1>('idle');
  const horizontalSessionRef = useRef<PageMoveHorizontalSessionV1 | null>(null);
  const startClientYRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const availableRef = useRef(false);
  const captureActiveRef = useRef(false);
  const modeRef = useRef(mode);
  const moveToggleRef = useRef(moveToggle);
  const hasRootCanvas = canvasSize !== null;
  const showToolbar = toolbar !== null && !presentationActive;
  modeRef.current = mode;
  moveToggleRef.current = moveToggle;

  const setCaptureActive = useCallback(
    (active: boolean) => {
      if (captureActiveRef.current === active) return;
      captureActiveRef.current = active;
      onMoveCaptureActiveChange(active);
    },
    [onMoveCaptureActiveChange],
  );
  const cancelFrame = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);
  const commitMoveX = useCallback((next: number) => {
    moveXRef.current = next;
    setMoveX(next);
  }, []);
  const releaseCapture = useCallback((pointerId: number) => {
    const plane = contentRef.current;
    if (plane === null) return;
    try {
      if (plane.hasPointerCapture(pointerId)) plane.releasePointerCapture(pointerId);
    } catch {
      // Cleanup remains fail-closed when a browser invalidates capture first.
    }
  }, []);
  const finishGesture = useCallback(
    (action: 'preserve' | 'reset' | 'reclamp' = 'preserve') => {
      cancelFrame();
      const session = horizontalSessionRef.current;
      horizontalSessionRef.current = null;
      pointerStateRef.current = 'idle';
      if (session !== null) releaseCapture(session.pointerId);
      setCaptureActive(false);
      if (action === 'reset') commitMoveX(0);
      else if (action === 'reclamp') {
        const geometry = geometryRef.current;
        commitMoveX(
          clampPageMoveXV1(moveXRef.current, geometry.viewportWidth, geometry.contentWidth),
        );
      }
    },
    [cancelFrame, commitMoveX, releaseCapture, setCaptureActive],
  );
  const applyLatestMove = useCallback(() => {
    rafRef.current = null;
    const session = horizontalSessionRef.current;
    if (session === null || pointerStateRef.current !== 'horizontal-locked') return;
    const geometry = geometryRef.current;
    commitMoveX(
      nextPageMoveXV1({
        ...session,
        viewportWidth: geometry.viewportWidth,
        contentWidth: geometry.contentWidth,
      }),
    );
  }, [commitMoveX]);
  const bindStage = useCallback(
    (element: HTMLDivElement | null) => {
      localStageRef.current = element;
      stageRef(element);
    },
    [stageRef],
  );

  useLayoutEffect(() => {
    const stage = localStageRef.current;
    const content = contentRef.current;
    if (stage === null || content === null) return;
    let observer: ResizeObserver | null = null;
    const observedElements = new Set<Element>();
    const observe = (element: Element | null) => {
      if (element === null || observer === null || observedElements.has(element)) return;
      observedElements.add(element);
      observer.observe(element);
    };
    const fitNestedCanvases = () => {
      const canvasStages = Array.from(content.querySelectorAll<HTMLElement>('.scene-canvas-stage'));
      const rootCanvasStage = hasRootCanvas ? (canvasStages[0] ?? null) : null;
      for (const canvasStage of canvasStages) {
        observe(canvasStage);
        if (canvasStage === rootCanvasStage) {
          clearNestedCanvasFit(canvasStage);
          continue;
        }
        const reserved = canvasStage.querySelector<HTMLElement>(':scope > .scene-canvas-reserved');
        const plane = reserved?.querySelector<HTMLElement>(':scope > .scene-canvas-plane');
        if (plane === undefined || plane === null) {
          clearNestedCanvasFit(canvasStage);
          continue;
        }
        const containingCanvasChild = canvasStage.closest<HTMLElement>('.scene-canvas-child');
        observe(containingCanvasChild);
        const fit = createNestedCanvasFitV1({
          availableWidth: canvasStage.clientWidth,
          ...(containingCanvasChild === null
            ? {}
            : { availableHeight: containingCanvasChild.clientHeight }),
          canvasWidth: canvasDimension(canvasStage, plane, '--scene-canvas-width'),
          canvasHeight: canvasDimension(canvasStage, plane, '--scene-canvas-height'),
        });
        if (fit === null) {
          clearNestedCanvasFit(canvasStage);
          continue;
        }
        canvasStage.dataset.pageNestedCanvasFit = 'true';
        canvasStage.style.setProperty('--page-canvas-scale', String(fit.scale));
        canvasStage.style.setProperty('--page-canvas-origin-x', '0px');
        canvasStage.style.setProperty('--page-canvas-move-x', '0px');
        canvasStage.style.setProperty('--page-canvas-reserved-width', `${fit.reservedWidth}px`);
        canvasStage.style.setProperty('--page-canvas-reserved-height', `${fit.reservedHeight}px`);
      }
      return canvasStages;
    };
    const measure = () => {
      if (pointerStateRef.current !== 'idle') finishGesture('reclamp');
      fitNestedCanvases();
      const nextViewport = {
        width: Math.max(0, stage.clientWidth),
        height: Math.max(0, stage.clientHeight),
      };
      const canvasPlane = content.querySelector<HTMLElement>('.scene-canvas-plane');
      const nextContentWidth = Math.max(
        0,
        canvasSize?.width ?? canvasPlane?.scrollWidth ?? content.scrollWidth,
      );
      const nextAnnotationSurface = {
        width: Math.max(1, nextViewport.width, content.scrollWidth),
        height: Math.max(1, nextViewport.height, content.scrollHeight),
      };
      geometryRef.current = {
        viewportWidth: nextViewport.width,
        contentWidth: nextContentWidth,
      };
      setViewport(nextViewport);
      setContentWidth(nextContentWidth);
      setAnnotationSurface((current) =>
        current.width === nextAnnotationSurface.width &&
        current.height === nextAnnotationSurface.height
          ? current
          : nextAnnotationSurface,
      );
      const available = pageMoveIsAvailableV1(
        modeRef.current,
        nextViewport.width,
        nextContentWidth,
      );
      if (availableRef.current !== available) {
        availableRef.current = available;
        onMoveAvailabilityChange(available);
      }
      commitMoveX(clampPageMoveXV1(moveXRef.current, nextViewport.width, nextContentWidth));
    };
    observer = new ResizeObserver(measure);
    observe(stage);
    observe(content);
    measure();
    content.addEventListener('load', measure, true);
    return () => {
      observer.disconnect();
      content.removeEventListener('load', measure, true);
      for (const canvasStage of content.querySelectorAll<HTMLElement>('.scene-canvas-stage'))
        clearNestedCanvasFit(canvasStage);
    };
  }, [
    canvasSize?.height,
    canvasSize?.width,
    commitMoveX,
    finishGesture,
    hasRootCanvas,
    moveIdentity,
    onMoveAvailabilityChange,
    presentationActive,
  ]);
  useLayoutEffect(() => {
    if (!showToolbar) {
      setNavigationHeight(0);
      return;
    }
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const navigation = toolbar.querySelector<HTMLElement>('[data-page-bottom-navigation]');
    if (navigation === null) return;
    const measure = () =>
      setNavigationHeight(Math.max(0, navigation.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [showToolbar]);

  useEffect(() => {
    const geometry = geometryRef.current;
    const available = pageMoveIsAvailableV1(mode, geometry.viewportWidth, geometry.contentWidth);
    if (availableRef.current !== available) {
      availableRef.current = available;
      onMoveAvailabilityChange(available);
    }
    if (!available || !moveToggle) finishGesture('reset');
  }, [finishGesture, mode, moveToggle, onMoveAvailabilityChange]);
  useEffect(() => {
    finishGesture('reset');
  }, [finishGesture, moveIdentity]);
  useEffect(() => {
    finishGesture('reclamp');
  }, [finishGesture, presentationActive]);

  useEffect(() => {
    const plane = contentRef.current;
    const stage = localStageRef.current;
    if (plane === null || stage === null) return;
    const interactiveSelector =
      'input,textarea,select,button,a,[contenteditable],[role="button"],[role="link"],[role="dialog"],[role="menu"],[role="listbox"],[data-artifact-capture],[data-hitl-capture]';
    const interactivePath = (event: PointerEvent) =>
      event
        .composedPath()
        .some((target) => target instanceof Element && target.matches(interactiveSelector));
    const pointerDown = (event: PointerEvent) => {
      if (pointerStateRef.current !== 'idle') {
        finishGesture('reclamp');
        return;
      }
      const rect = stage.getBoundingClientRect();
      if (
        !admitPageMovePointerDownV1({
          moveToggle: moveToggleRef.current && availableRef.current,
          displayMode: modeRef.current,
          pointerActive: false,
          isTrusted: event.isTrusted,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons: event.buttons,
          interactivePath: interactivePath(event),
          clientX: event.clientX,
          viewportLeft: rect.left,
          viewportRight: rect.right,
        })
      )
        return;
      horizontalSessionRef.current = Object.freeze({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        baseX: moveXRef.current,
        latestClientX: event.clientX,
      });
      startClientYRef.current = event.clientY;
      pointerStateRef.current = 'pending';
    };
    const pointerMove = (event: PointerEvent) => {
      const session = horizontalSessionRef.current;
      if (session === null || event.pointerId !== session.pointerId) return;
      if (pointerStateRef.current === 'native-yielded') return;
      if (pointerStateRef.current === 'pending') {
        const intent = classifyPageMoveIntentV1(
          event.clientX - session.startClientX,
          event.clientY - startClientYRef.current,
        );
        pointerStateRef.current = intent;
        if (intent !== 'horizontal-locked') return;
        try {
          plane.setPointerCapture(event.pointerId);
          if (!plane.hasPointerCapture(event.pointerId)) {
            pointerStateRef.current = 'native-yielded';
            return;
          }
        } catch {
          pointerStateRef.current = 'native-yielded';
          return;
        }
        setCaptureActive(true);
      }
      horizontalSessionRef.current = Object.freeze({
        ...session,
        latestClientX: event.clientX,
      });
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(applyLatestMove);
      if (event.cancelable) event.preventDefault();
    };
    const pointerUp = (event: PointerEvent) => {
      const session = horizontalSessionRef.current;
      if (session === null || event.pointerId !== session.pointerId) return;
      if (pointerStateRef.current === 'horizontal-locked') {
        horizontalSessionRef.current = Object.freeze({
          ...session,
          latestClientX: event.clientX,
        });
        cancelFrame();
        applyLatestMove();
      }
      finishGesture('reclamp');
    };
    const pointerCancel = (event: PointerEvent) => {
      if (horizontalSessionRef.current?.pointerId === event.pointerId) finishGesture('reclamp');
    };
    const lostCapture = (event: PointerEvent) => {
      if (horizontalSessionRef.current?.pointerId === event.pointerId) finishGesture('reclamp');
    };
    const cleanup = () => finishGesture('reclamp');
    const visibilityCleanup = () => {
      if (document.visibilityState === 'hidden') cleanup();
    };
    plane.addEventListener('pointerdown', pointerDown, { passive: true });
    plane.addEventListener('pointermove', pointerMove, { passive: false });
    plane.addEventListener('pointerup', pointerUp, { passive: true });
    plane.addEventListener('pointercancel', pointerCancel, { passive: true });
    plane.addEventListener('lostpointercapture', lostCapture, { passive: true });
    window.addEventListener('blur', cleanup);
    window.addEventListener('orientationchange', cleanup);
    document.addEventListener('visibilitychange', visibilityCleanup);
    return () => {
      plane.removeEventListener('pointerdown', pointerDown);
      plane.removeEventListener('pointermove', pointerMove);
      plane.removeEventListener('pointerup', pointerUp);
      plane.removeEventListener('pointercancel', pointerCancel);
      plane.removeEventListener('lostpointercapture', lostCapture);
      window.removeEventListener('blur', cleanup);
      window.removeEventListener('orientationchange', cleanup);
      document.removeEventListener('visibilitychange', visibilityCleanup);
      finishGesture('reclamp');
    };
  }, [applyLatestMove, cancelFrame, finishGesture, setCaptureActive]);

  const transform =
    canvasSize === null
      ? null
      : createPageCanvasTransformV1({
          mode,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          canvasWidth: canvasSize.width,
          canvasHeight: canvasSize.height,
          moveX,
        });
  const stageProperties: StagePropertiesV1 =
    transform === null
      ? {
          // Expose the measured stage height so artifact hosts fill it without the retired 55vh cap.
          // useLayoutEffect measures before paint, so the initial 0px value is not rendered.
          '--page-stage-viewport-height': `${viewport.height}px`,
          '--mobile-page-controls-height': `${navigationHeight}px`,
        }
      : {
          '--page-canvas-scale': transform.scale,
          '--page-canvas-origin-x': `${transform.originX}px`,
          '--page-canvas-move-x': `${transform.moveX}px`,
          '--page-canvas-reserved-width': `${transform.reservedWidth}px`,
          '--page-canvas-reserved-height': `${transform.reservedHeight}px`,
          '--page-stage-viewport-height': `${viewport.height}px`,
          '--mobile-page-controls-height': `${navigationHeight}px`,
        };
  useEffect(() => {
    onCanvasTransformChange?.(transform);
    return () => onCanvasTransformChange?.(null);
  }, [onCanvasTransformChange, transform]);

  return (
    <div
      className={styles.root}
      data-presentation-active={presentationActive}
      data-has-toolbar={showToolbar}
    >
      {showToolbar && (
        <div ref={toolbarRef} className={styles.toolbar}>
          {toolbar}
        </div>
      )}
      <div
        ref={bindStage}
        className={styles.stage}
        style={stageProperties}
        data-page-scroll-owner="PAGE"
        data-page-heading
        data-page-display-mode={mode}
        data-page-move-effective={
          moveToggle && pageMoveIsAvailableV1(mode, viewport.width, contentWidth)
        }
        tabIndex={0}
        aria-label={label}
      >
        {overlay}
        <PresentationAnnotationLayer
          active={presentationActive}
          pageKey={annotationPageKey ?? moveIdentity}
          width={annotationSurface.width}
          height={annotationSurface.height}
          readOnly={annotationReadOnly}
          externalStrokes={annotationStrokes}
          {...(onAnnotationStrokesChange === undefined
            ? {}
            : { onVisibleStateChange: onAnnotationStrokesChange })}
          {...(annotationToolbarTarget === undefined
            ? {}
            : { toolbarTarget: annotationToolbarTarget })}
        />
        <div ref={contentRef} className={styles.content} data-page-move-plane>
          {children}
        </div>
      </div>
    </div>
  );
}
