'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  PUBLIC_PRESENTATION_MAX_POINTS_PER_STROKE_V1,
  PUBLIC_PRESENTATION_MAX_POINTS_V1,
  PUBLIC_PRESENTATION_MAX_STROKES_V1,
} from '@sceneboard/board-schema';

import {
  commitPresentationAnnotationSnapshotV1,
  commitPresentationAnnotationStrokeV1,
  createPresentationAnnotationHistoryV1,
  createPresentationAnnotationPageHistoryV1,
  erasePresentationAnnotationStrokesV1,
  normalizePresentationAnnotationPointV1,
  presentationAnnotationPathV1,
  presentationAnnotationGestureDispositionV1,
  presentationAnnotationHistoryCommandV1,
  redoPresentationAnnotationV1,
  undoPresentationAnnotationV1,
  type PresentationAnnotationHistoryV1,
  type PresentationAnnotationPointV1,
  type PresentationAnnotationStrokeV1,
  type PresentationAnnotationToolV1,
} from '../../lib/board/presentation-annotation.controller';
import { useI18n } from '../i18n/I18nProvider';
import styles from './PresentationAnnotationLayer.module.css';

type AnnotationGestureV1 =
  | Readonly<{
      pointerId: number;
      element: SVGSVGElement;
      tool: 'pen';
      base: PresentationAnnotationHistoryV1;
      points: readonly PresentationAnnotationPointV1[];
      color: string;
      width: number;
    }>
  | Readonly<{
      pointerId: number;
      element: SVGSVGElement;
      tool: 'eraser';
      base: PresentationAnnotationHistoryV1;
      strokes: readonly PresentationAnnotationStrokeV1[];
    }>;

const editableShortcutPath = (event: KeyboardEvent): boolean =>
  event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
    );

const DEFAULT_PEN_COLOR = '#e5484d';
const DEFAULT_PEN_WIDTH = 4;
export type PresentationAnnotationDeliveryV1 = 'transient' | 'final';
const pointCount = (strokes: readonly PresentationAnnotationStrokeV1[]): number =>
  strokes.reduce((total, stroke) => total + stroke.points.length, 0);

export function PresentationAnnotationLayer({
  active,
  pageKey,
  width,
  height,
  toolbarTarget = null,
  readOnly = false,
  externalStrokes = [],
  onVisibleStateChange,
}: {
  active: boolean;
  pageKey: string;
  width: number;
  height: number;
  toolbarTarget?: HTMLElement | null;
  readOnly?: boolean;
  externalStrokes?: readonly PresentationAnnotationStrokeV1[];
  onVisibleStateChange?: (
    strokes: readonly PresentationAnnotationStrokeV1[],
    delivery: PresentationAnnotationDeliveryV1,
  ) => void;
}) {
  const { t } = useI18n();
  const historiesRef = useRef(new Map<string, PresentationAnnotationHistoryV1>());
  const historyRef = useRef(createPresentationAnnotationHistoryV1());
  const externalStrokesRef = useRef(externalStrokes);
  const gestureRef = useRef<AnnotationGestureV1 | null>(null);
  const [tool, setTool] = useState<PresentationAnnotationToolV1>('pointer');
  const [penColor, setPenColor] = useState(DEFAULT_PEN_COLOR);
  const [penWidth, setPenWidth] = useState(DEFAULT_PEN_WIDTH);
  const [history, setHistory] = useState(historyRef.current);
  const [draftStroke, setDraftStroke] = useState<PresentationAnnotationStrokeV1 | null>(null);
  externalStrokesRef.current = externalStrokes;

  useEffect(() => {
    if (!active || readOnly) return;
    onVisibleStateChange?.(history.present, gestureRef.current === null ? 'final' : 'transient');
  }, [active, history, onVisibleStateChange, readOnly]);

  useEffect(() => {
    if (!active || readOnly || draftStroke === null) return;
    onVisibleStateChange?.([...historyRef.current.present, draftStroke], 'transient');
  }, [active, draftStroke, onVisibleStateChange, readOnly]);

  const showHistory = useCallback((next: PresentationAnnotationHistoryV1) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const commitHistory = useCallback(
    (next: PresentationAnnotationHistoryV1) => {
      historiesRef.current.set(pageKey, next);
      showHistory(next);
    },
    [pageKey, showHistory],
  );

  const finishGesture = useCallback(
    (shouldCommit: boolean) => {
      const gesture = gestureRef.current;
      if (gesture === null) return;
      gestureRef.current = null;
      try {
        if (gesture.element.hasPointerCapture(gesture.pointerId))
          gesture.element.releasePointerCapture(gesture.pointerId);
      } catch {}
      setDraftStroke(null);
      if (!shouldCommit) {
        showHistory(gesture.base);
        return;
      }
      const next =
        gesture.tool === 'pen'
          ? commitPresentationAnnotationStrokeV1(gesture.base, {
              id: `annotation-${crypto.randomUUID()}`,
              points: gesture.points,
              color: gesture.color,
              width: gesture.width,
            })
          : commitPresentationAnnotationSnapshotV1(gesture.base, gesture.strokes);
      commitHistory(next);
    },
    [commitHistory, showHistory],
  );

  useLayoutEffect(() => {
    if (!active) return;
    finishGesture(false);
    let next = historiesRef.current.get(pageKey);
    if (next === undefined) {
      next = createPresentationAnnotationPageHistoryV1({
        readOnly,
        externalStrokes: externalStrokesRef.current,
      });
      historiesRef.current.set(pageKey, next);
    }
    showHistory(next);
  }, [active, finishGesture, pageKey, readOnly, showHistory]);

  useEffect(() => {
    if (active) return;
    finishGesture(false);
    historiesRef.current.clear();
    setTool('pointer');
    showHistory(createPresentationAnnotationHistoryV1());
  }, [active, finishGesture, showHistory]);

  const runHistoryCommand = useCallback(
    (command: 'undo' | 'redo') => {
      finishGesture(false);
      const current = historyRef.current;
      const next =
        command === 'undo'
          ? undoPresentationAnnotationV1(current)
          : redoPresentationAnnotationV1(current);
      if (next === current) return false;
      commitHistory(next);
      return true;
    },
    [commitHistory, finishGesture],
  );

  const clearAllAnnotations = useCallback(() => {
    finishGesture(false);
    historiesRef.current.clear();
    const next = createPresentationAnnotationHistoryV1();
    historiesRef.current.set(pageKey, next);
    showHistory(next);
  }, [finishGesture, pageKey, showHistory]);

  useEffect(() => {
    if (!active) return;
    const keyDown = (event: KeyboardEvent) => {
      const command = presentationAnnotationHistoryCommandV1({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        editableContext: editableShortcutPath(event),
      });
      if (command === null || !runHistoryCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [active, runHistoryCommand]);

  const pointFromEvent = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): PresentationAnnotationPointV1 => {
      const rect = event.currentTarget.getBoundingClientRect();
      return normalizePresentationAnnotationPointV1({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        width,
        height,
      });
    },
    [height, width],
  );

  const eraseAtPoint = useCallback(
    (strokes: readonly PresentationAnnotationStrokeV1[], point: PresentationAnnotationPointV1) =>
      erasePresentationAnnotationStrokesV1({
        strokes,
        point,
        width,
        height,
        threshold: 14,
      }),
    [height, width],
  );

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      readOnly ||
      tool === 'pointer' ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0)
    )
      return;
    finishGesture(false);
    const point = pointFromEvent(event);
    const base = historyRef.current;
    if (
      tool === 'pen' &&
      (base.present.length >= PUBLIC_PRESENTATION_MAX_STROKES_V1 ||
        pointCount(base.present) >= PUBLIC_PRESENTATION_MAX_POINTS_V1)
    )
      return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    if (tool === 'pen') {
      const points = [point];
      gestureRef.current = {
        pointerId: event.pointerId,
        element: event.currentTarget,
        tool,
        base,
        points,
        color: penColor,
        width: penWidth,
      };
      setDraftStroke({ id: 'draft', points, color: penColor, width: penWidth });
    } else {
      const strokes = eraseAtPoint(base.present, point);
      gestureRef.current = {
        pointerId: event.pointerId,
        element: event.currentTarget,
        tool,
        base,
        strokes,
      };
      showHistory({ ...base, present: strokes });
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const point = pointFromEvent(event);
    if (gesture.tool === 'pen') {
      const availablePoints = Math.min(
        PUBLIC_PRESENTATION_MAX_POINTS_PER_STROKE_V1,
        PUBLIC_PRESENTATION_MAX_POINTS_V1 - pointCount(gesture.base.present),
      );
      if (gesture.points.length >= availablePoints) return;
      const previous = gesture.points.at(-1);
      if (previous !== undefined) {
        const deltaX = (point.x - previous.x) * width;
        const deltaY = (point.y - previous.y) * height;
        if (deltaX ** 2 + deltaY ** 2 < 1) return;
      }
      const points = [...gesture.points, point];
      gestureRef.current = { ...gesture, points };
      setDraftStroke({
        id: 'draft',
        points,
        color: gesture.color,
        width: gesture.width,
      });
    } else {
      const strokes = eraseAtPoint(gesture.strokes, point);
      if (strokes !== gesture.strokes) {
        gestureRef.current = { ...gesture, strokes };
        showHistory({ ...gesture.base, present: strokes });
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const selectTool = (next: PresentationAnnotationToolV1) => {
    finishGesture(presentationAnnotationGestureDispositionV1('tool-change') === 'commit');
    setTool(next);
  };

  if (!active) return null;

  const renderedStrokes = readOnly
    ? externalStrokes
    : draftStroke === null
      ? history.present
      : [...history.present, draftStroke];

  const toolbar = (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t('presentation.annotationTools')}
      data-placement={toolbarTarget === null ? 'floating' : 'topbar'}
    >
      {(['pointer', 'pen', 'eraser'] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={tool === candidate}
          onClick={() => selectTool(candidate)}
        >
          {t(
            `presentation.annotation${candidate[0]!.toUpperCase()}${candidate.slice(1)}` as
              | 'presentation.annotationPointer'
              | 'presentation.annotationPen'
              | 'presentation.annotationEraser',
          )}
        </button>
      ))}
      {tool === 'pen' && (
        <>
          <label className={styles.colorControl} title={t('presentation.annotationPenColor')}>
            <span className="visually-hidden">{t('presentation.annotationPenColor')}</span>
            <input
              type="color"
              value={penColor}
              aria-label={t('presentation.annotationPenColor')}
              onChange={(event) => setPenColor(event.target.value)}
            />
          </label>
          <select
            className={styles.widthControl}
            value={penWidth}
            aria-label={t('presentation.annotationPenWidth')}
            title={t('presentation.annotationPenWidth')}
            onChange={(event) => setPenWidth(Number(event.target.value))}
          >
            <option value={2}>2 px</option>
            <option value={4}>4 px</option>
            <option value={8}>8 px</option>
          </select>
        </>
      )}
      <button
        type="button"
        disabled={history.past.length === 0}
        onClick={() => runHistoryCommand('undo')}
      >
        {t('presentation.annotationUndo')}
      </button>
      <button
        type="button"
        disabled={history.future.length === 0}
        onClick={() => runHistoryCommand('redo')}
      >
        {t('presentation.annotationRedo')}
      </button>
      <button type="button" onClick={clearAllAnnotations}>
        {t('presentation.annotationClearAll')}
      </button>
    </div>
  );

  return (
    <div
      className={styles.root}
      style={{ width: `${width}px`, height: `${height}px` }}
      data-presentation-annotation-layer
      data-presentation-annotation-readonly={readOnly}
    >
      <svg
        className={styles.canvas}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        data-tool={tool}
        data-presentation-annotation-canvas
        aria-hidden="true"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={(event) => {
          if (gestureRef.current?.pointerId === event.pointerId) finishGesture(true);
        }}
        onPointerCancel={(event) => {
          if (gestureRef.current?.pointerId === event.pointerId) finishGesture(false);
        }}
        onLostPointerCapture={(event) => {
          if (gestureRef.current?.pointerId === event.pointerId) finishGesture(true);
        }}
      >
        {renderedStrokes.map((stroke) => (
          <path
            key={stroke.id}
            className={styles.stroke}
            d={presentationAnnotationPathV1(stroke.points, width, height)}
            stroke={stroke.color}
            strokeWidth={stroke.width}
          />
        ))}
      </svg>
      {!readOnly && (toolbarTarget === null ? toolbar : createPortal(toolbar, toolbarTarget))}
    </div>
  );
}
