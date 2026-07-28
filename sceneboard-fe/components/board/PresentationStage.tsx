'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  createPageCanvasTransformV1,
  type PageDisplayModeV1,
} from '../../lib/board/page-display-mode.types';
import styles from './PresentationStage.module.css';

type CanvasSizeV1 = Readonly<{ width: number; height: number }> | null;
type StagePropertiesV1 = CSSProperties &
  Readonly<Record<`--page-canvas-${string}`, string | number>>;

export function PresentationStage({
  stageRef,
  mode,
  canvasSize,
  toolbar,
  overlay,
  presentationActive,
  children,
  label,
}: {
  stageRef: (element: HTMLDivElement | null) => void;
  mode: PageDisplayModeV1;
  canvasSize: CanvasSizeV1;
  toolbar: ReactNode;
  overlay: ReactNode;
  presentationActive: boolean;
  children: ReactNode;
  label: string;
}) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const localStageRef = useRef<HTMLDivElement | null>(null);
  const bindStage = useCallback(
    (element: HTMLDivElement | null) => {
      localStageRef.current = element;
      stageRef(element);
    },
    [stageRef],
  );

  useLayoutEffect(() => {
    const stage = localStageRef.current;
    if (stage === null) return;
    const measure = () => {
      setViewport({
        width: Math.max(0, stage.clientWidth),
        height: Math.max(0, stage.clientHeight),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const transform =
    canvasSize === null
      ? null
      : createPageCanvasTransformV1({
          mode,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          canvasWidth: canvasSize.width,
          canvasHeight: canvasSize.height,
        });
  const stageProperties: StagePropertiesV1 | undefined =
    transform === null
      ? undefined
      : {
          '--page-canvas-scale': transform.scale,
          '--page-canvas-origin-x': `${transform.originX}px`,
          '--page-canvas-move-x': `${transform.moveX}px`,
          '--page-canvas-reserved-width': `${transform.reservedWidth}px`,
          '--page-canvas-reserved-height': `${transform.reservedHeight}px`,
        };

  return (
    <div className={styles.root} data-presentation-active={presentationActive}>
      <div className={styles.toolbar}>{toolbar}</div>
      <div
        ref={bindStage}
        className={styles.stage}
        style={stageProperties}
        data-page-scroll-owner="PAGE"
        data-page-display-mode={mode}
        tabIndex={0}
        aria-label={label}
      >
        {overlay}
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
