export const ARTIFACT_BROKER_ERRORS = {
  INVALID_REQUEST: { status: 400, message: 'Invalid network request' },
  POLICY_DENIED: { status: 403, message: 'Network access is not allowed' },
  ARTIFACT_NOT_FOUND: { status: 404, message: 'Artifact is not available' },
  UPSTREAM_TIMEOUT: { status: 504, message: 'Upstream request timed out' },
  UPSTREAM_REJECTED: { status: 502, message: 'Upstream response was rejected' },
  RESPONSE_TOO_LARGE: { status: 413, message: 'Upstream response is too large' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Network service is unavailable' },
} as const;

export type ArtifactBrokerErrorCode = keyof typeof ARTIFACT_BROKER_ERRORS;

export class ArtifactBrokerError extends Error {
  readonly status: number;

  constructor(
    readonly code: ArtifactBrokerErrorCode,
    readonly requestId: string,
  ) {
    const definition = ARTIFACT_BROKER_ERRORS[code];
    super(definition.message);
    this.name = 'ArtifactBrokerError';
    this.status = definition.status;
  }

  toPayload(): { error: { code: ArtifactBrokerErrorCode; message: string; requestId: string } } {
    return { error: { code: this.code, message: this.message, requestId: this.requestId } };
  }
}
