import { redactSecrets } from './redact-secrets.js';

export const BACKEND_SECRET_SINKS_V1 = [
  'APPLICATION_LOG',
  'METRIC',
  'ERROR',
  'HTTP_RESPONSE_OR_URL',
  'RETRY_QUEUE_OR_OUTBOX',
] as const;

export type BackendSecretSinkV1 = (typeof BACKEND_SECRET_SINKS_V1)[number];

export interface SecretSinkObserverV1 {
  observe(bytes: string): void;
}

export const BACKEND_ERROR_SINK_OBSERVER_V1 = Symbol('BACKEND_ERROR_SINK_OBSERVER_V1');

export const productionBackendErrorSinkObserverV1: SecretSinkObserverV1 = Object.freeze({
  observe(bytes: string): void {
    process.stderr.write(`${bytes}\n`);
  },
});

export interface SecretSinkDispatchResultV1 {
  disposition: 'SANITIZED';
  observedRecords: number;
  producerEntrypoint: 'dispatchBackendSecretSinkV1';
  sink: BackendSecretSinkV1;
}

const assertObserver = (observer: SecretSinkObserverV1): void => {
  if (!observer || typeof observer.observe !== 'function') {
    throw new TypeError('secret sink observer is required');
  }
};

const serialize = (value: unknown): string => JSON.stringify(value);

/**
 * Production-owned last-mile boundary for dynamic diagnostic material.
 *
 * Raw caller data enters here. Only the redacted representation can reach the
 * observer, so certification can capture the exact post-boundary records
 * without gaining a raw-secret output hook.
 */
export const dispatchBackendSecretSinkV1 = ({
  sink,
  rawPayload,
  observer,
}: {
  sink: BackendSecretSinkV1;
  rawPayload: unknown;
  observer: SecretSinkObserverV1;
}): SecretSinkDispatchResultV1 => {
  assertObserver(observer);
  if (!BACKEND_SECRET_SINKS_V1.includes(sink)) {
    throw new TypeError('unsupported backend secret sink');
  }

  const safePayload = redactSecrets(rawPayload);
  const records: string[] = [];
  if (sink === 'APPLICATION_LOG') {
    records.push(
      `${serialize({ level: 'error', event: 'operation.failed', data: safePayload })}\n`,
    );
  } else if (sink === 'METRIC') {
    records.push(serialize({ name: 'operation_failure_total', labels: safePayload, value: 1 }));
  } else if (sink === 'ERROR') {
    records.push(
      serialize({
        name: 'SafeOperationalError',
        message: 'Operation failed',
        details: safePayload,
      }),
    );
  } else if (sink === 'HTTP_RESPONSE_OR_URL') {
    records.push(serialize({ error: safePayload }));
    records.push('/api/v1/boards/invalid');
  } else if (sink === 'RETRY_QUEUE_OR_OUTBOX') {
    records.push(serialize({ attempt: 1, payload: safePayload }));
  }

  if (records.length === 0) throw new Error('secret sink produced no observable record');
  for (const record of records) observer.observe(record);
  return Object.freeze({
    disposition: 'SANITIZED',
    observedRecords: records.length,
    producerEntrypoint: 'dispatchBackendSecretSinkV1',
    sink,
  });
};
