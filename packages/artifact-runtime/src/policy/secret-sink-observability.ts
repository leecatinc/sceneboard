export const ARTIFACT_SECRET_SINKS_V1 = [
  'DOM',
  'BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER',
  'SCREENSHOT_TRACE_OR_VIDEO',
] as const;

export type ArtifactSecretSinkV1 = (typeof ARTIFACT_SECRET_SINKS_V1)[number];

export interface ArtifactSecretSinkObserverV1 {
  observe(bytes: string): void;
}

export interface ArtifactSecretSinkDispatchResultV1 {
  disposition: 'REJECTED_UNSUPPORTED';
  observedRecords: 1;
  producerEntrypoint: 'rejectArtifactSecretSinkV1';
  sink: ArtifactSecretSinkV1;
}

/**
 * Artifact surfaces never accept credential-bearing diagnostic payloads.
 * The raw value deliberately has no read path: the production boundary rejects
 * the operation before DOM, storage, service-worker, screenshot, trace, or
 * video material can be created. The observer receives only a constant record.
 */
export const rejectArtifactSecretSinkV1 = ({
  sink,
  rawPayload: _rawPayload,
  observer,
}: {
  sink: ArtifactSecretSinkV1;
  rawPayload: unknown;
  observer: ArtifactSecretSinkObserverV1;
}): ArtifactSecretSinkDispatchResultV1 => {
  if (!observer || typeof observer.observe !== 'function') {
    throw new TypeError('artifact secret sink observer is required');
  }
  if (!ARTIFACT_SECRET_SINKS_V1.includes(sink)) {
    throw new TypeError('unsupported artifact secret sink');
  }
  observer.observe(JSON.stringify({ code: 'SECRET_SINK_REJECTED', sink }));
  return Object.freeze({
    disposition: 'REJECTED_UNSUPPORTED',
    observedRecords: 1,
    producerEntrypoint: 'rejectArtifactSecretSinkV1',
    sink,
  });
};
