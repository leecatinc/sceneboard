'use client';

import { useEffect, useRef } from 'react';

import type { ArtifactHostInputV1 } from './ports.js';
import { ArtifactFallback } from './ArtifactFallback.js';
import { useArtifactBridgeV1 } from './use-artifact-bridge.js';

export function ArtifactHost(input: ArtifactHostInputV1) {
  const bridge = useArtifactBridgeV1(input);
  const stopSignal = input.stopSignal ?? 0;
  const priorStopSignal = useRef(stopSignal);

  useEffect(() => {
    const container = bridge.containerRef.current;
    if (container === null) return undefined;
    const applyLayout = () => {
      const stage = container.querySelector<HTMLElement>('.artifact-runtime-stage');
      const frame = stage?.querySelector<HTMLIFrameElement>('.artifact-runtime-frame');
      if (stage === null || stage === undefined || frame === null || frame === undefined) return;
      const availableWidth = Math.max(1, container.clientWidth);
      const availableHeight = Math.max(1, container.clientHeight);
      const width = Math.max(1, bridge.contentSize?.width ?? availableWidth);
      const height = Math.max(1, bridge.contentSize?.height ?? availableHeight);
      const mode = input.viewMode ?? 'fit-height';
      const scale = mode === 'fit-height'
        ? availableHeight / height
        : mode === 'fit-width'
          ? availableWidth / width
          : 1;
      const renderedWidth = width * scale;
      const renderedHeight = height * scale;
      stage.style.width = `${renderedWidth}px`;
      stage.style.height = `${renderedHeight}px`;
      stage.style.marginLeft = renderedWidth < availableWidth ? `${(availableWidth - renderedWidth) / 2}px` : '0';
      stage.style.marginTop = renderedHeight < availableHeight ? `${(availableHeight - renderedHeight) / 2}px` : '0';
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      frame.style.transform = `scale(${scale})`;
      container.dataset.viewMode = mode;
    };
    applyLayout();
    const observer = new ResizeObserver(applyLayout);
    observer.observe(container);
    return () => observer.disconnect();
  }, [bridge.containerRef, bridge.contentSize, bridge.phase, input.viewMode]);

  useEffect(() => {
    if (priorStopSignal.current === stopSignal) return;
    priorStopSignal.current = stopSignal;
    bridge.stop();
  }, [bridge.stop, stopSignal]);

  return (
    <section className={`artifact-host artifact-${bridge.phase}`} aria-label="Isolated artifact">
      <div ref={bridge.containerRef} className="artifact-frame-container" aria-hidden={bridge.phase !== 'active'} />
      {bridge.phase === 'active' ? null : <ArtifactFallback phase={bridge.phase} correlationId={bridge.correlationId} />}
      {(input.showStopControl ?? true) && (bridge.phase === 'loading' || bridge.phase === 'handshaking' || bridge.phase === 'active') && (
        <button type="button" className="artifact-stop" onClick={bridge.stop}>Stop rendering</button>
      )}
    </section>
  );
}
