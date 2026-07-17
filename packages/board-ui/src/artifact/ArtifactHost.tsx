'use client';

import type { ArtifactHostInputV1 } from './ports.js';
import { ArtifactFallback } from './ArtifactFallback.js';
import { useArtifactBridgeV1 } from './use-artifact-bridge.js';

export function ArtifactHost(input: ArtifactHostInputV1) {
  const bridge = useArtifactBridgeV1(input);
  return (
    <section className={`artifact-host artifact-${bridge.phase}`} aria-label="Isolated artifact">
      <div ref={bridge.containerRef} className="artifact-frame-container" aria-hidden={bridge.phase !== 'active'} />
      {bridge.phase === 'active' ? null : <ArtifactFallback phase={bridge.phase} correlationId={bridge.correlationId} />}
      {(bridge.phase === 'loading' || bridge.phase === 'handshaking' || bridge.phase === 'active') && (
        <button type="button" className="artifact-stop" onClick={bridge.stop}>Stop rendering</button>
      )}
    </section>
  );
}
