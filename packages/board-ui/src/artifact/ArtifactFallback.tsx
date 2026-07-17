import type { ArtifactHostPhaseV1 } from './use-artifact-bridge.js';

const COPY: Record<Exclude<ArtifactHostPhaseV1, 'active'>, string> = {
  loading: 'Preparing the isolated artifact…',
  handshaking: 'Verifying the isolated renderer…',
  stopped: 'Rendering stopped on this device.',
  blocked: 'This artifact is blocked by the current policy.',
  failed: 'The isolated artifact could not be rendered safely.',
  unsupported: 'This browser cannot provide the required isolated runtime.',
};

export function ArtifactFallback({ phase, correlationId }: {
  phase: Exclude<ArtifactHostPhaseV1, 'active'>;
  correlationId: string | null;
}) {
  return (
    <div className="artifact-fallback" role={phase === 'failed' || phase === 'blocked' ? 'alert' : 'status'}>
      <p>{COPY[phase]}</p>
      {correlationId === null ? null : <p className="artifact-correlation">Reference: {correlationId}</p>}
    </div>
  );
}
