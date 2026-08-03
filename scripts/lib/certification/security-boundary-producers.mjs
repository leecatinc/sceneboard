import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';
import { register, tsImport } from 'tsx/esm/api';
import {
  securityProducerDefinition,
  validateSecurityCatalog,
  validateSecurityProducerMappings,
} from './security-catalog.mjs';
import { canonicalJson, sha256 } from './canonical-json.mjs';

const catalog = JSON.parse(
  await readFile(
    new URL('../../../test/certification/security-case-catalog.v1.json', import.meta.url),
  ),
);

const exactOwners =
  (...owners) =>
  () =>
    Object.freeze(owners);

const ownerRegistry = Object.freeze({
  'sceneboard.security.auth-session-pairing.v1': Object.freeze({
    AUTH_SESSION: (row) =>
      exactOwners(
        row.preconditionState === 'foreign-origin' || row.preconditionState === 'missing-origin'
          ? 'sceneboard.authentication-guard'
          : 'sceneboard.session-service',
      )(),
    ACCOUNT_API_KEY_AUTHENTICATION: exactOwners('sceneboard.account-api-key-service'),
    PAIRING: (row) =>
      exactOwners(
        row.caseId.startsWith('PAIR-GRANT-')
          ? 'sceneboard.grant-service'
          : 'sceneboard.pairing-service',
      )(),
  }),
  'sceneboard.security.authorization-cross-board.v1': Object.freeze({
    AUTHORIZATION: exactOwners('sceneboard.board-access-policy'),
    ACCOUNT_API_KEY_AUTHORIZATION: exactOwners('sceneboard.board-access-policy'),
    ACCOUNT_API_KEY_EXPORT: (row) => {
      if (
        row.preconditionState === 'local-helper-unavailable' ||
        row.preconditionState === 'local-final-already-exists'
      )
        return Object.freeze(['sceneboard.local-export-file']);
      const owners = [
        'sceneboard.export-authorization',
        'sceneboard.export-admission',
        'sceneboard.export-reservation',
      ];
      if (row.preconditionState !== 'account-board-credential-admission-limit') {
        owners.push('sceneboard.export-renderer');
        owners.push('sceneboard.export-terminal-audit');
      }
      return Object.freeze(owners);
    },
  }),
  'sceneboard.security.hitl-race.v1': Object.freeze({
    HITL_STATE: exactOwners('sceneboard.interaction-repository'),
    HITL_RACE: exactOwners('sceneboard.interaction-repository'),
    HITL_EXPIRY: exactOwners('sceneboard.interaction-repository'),
    HITL_DESTRUCTIVE: exactOwners(
      'sceneboard.interaction-command-service',
      'sceneboard.destructive-effect-consumer',
    ),
    HITL_LIVE_HISTORY: exactOwners('sceneboard.interaction-lifecycle-service'),
    SCENE_NONINTERACTIVE: exactOwners('sceneboard.interaction-command-service'),
  }),
  'sceneboard.security.secret-canary.v1': Object.freeze({
    SECRET_CANARY: (row) => {
      const sink = row.preconditionState.slice(row.preconditionState.indexOf('-scanned-in-') + 12);
      return Object.freeze([
        sink.startsWith('MCP_') ? 'sceneboard.mcp-secret-sink' : 'sceneboard.backend-secret-sink',
        `sceneboard.secret-transport.${sink.toLowerCase().replaceAll('_', '-')}`,
      ]);
    },
  }),
  'sceneboard.security.artifact-boundary.v1': Object.freeze({
    ARTIFACT_QUOTA: exactOwners('sceneboard.artifact-runtime'),
    ARTIFACT_POLICY: exactOwners('sceneboard.artifact-runtime'),
    ARTIFACT_HOSTILE: exactOwners(
      'sceneboard.artifact-runtime',
      'sceneboard.artifact-host',
      'sceneboard.artifact-runner',
    ),
  }),
  'sceneboard.security.hostile-payload.v1': Object.freeze({
    CARRIER_BOUNDARY: (row) =>
      exactOwners(
        row.preconditionState.startsWith('HTTP_') ||
          row.preconditionState.startsWith('ARTIFACT_SOURCE_BODY')
          ? 'sceneboard.http-carrier-admission'
          : 'sceneboard.contract-carrier-admission',
      )(),
    SCHEMA_CORPUS: exactOwners('sceneboard.schema-evaluator'),
  }),
  'sceneboard.security.mcp-registry.v1': Object.freeze({
    MCP: exactOwners('sceneboard.mcp-tool-registry'),
    MCP_ACCOUNT_API_KEY: exactOwners('sceneboard.mcp-tool-registry'),
  }),
});

const semanticObservation = (value, seen = new WeakSet()) => {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return '[symbol]';
  if (typeof value === 'bigint') return value.toString(10);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => semanticObservation(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, semanticObservation(entry, seen)]),
  );
};

const secretCanary = (secretClass, row) => {
  const short = Buffer.from(row.caseId).toString('base64url').padEnd(22, 'A').slice(0, 22);
  const long = `${short}${short}`.padEnd(43, 'B').slice(0, 43);
  if (secretClass === 'MCP_GRANT_ACCESS_TOKEN') return `lcbg_v1.${short}.${long}`;
  if (secretClass === 'ACCOUNT_API_KEY_TOKEN') return `sbk_v1.${short}.${long}`;
  if (secretClass === 'PAIRING_CODE') return 'ABCDEF-GHJKMN';
  if (secretClass === 'PAIRING_PROOF') return `PairingProof ${long}`;
  if (
    secretClass === 'SESSION_TOKEN' ||
    secretClass === 'SESSION_COOKIE_HEADER' ||
    secretClass === 'AUTHORIZATION_HEADER' ||
    secretClass === 'ARTIFACT_CAPABILITY_TICKET'
  )
    return `Bearer ${long}`;
  return `sk-${long}`;
};

const producerAttemptInput = (row, producerId) => {
  if (producerId !== 'sceneboard.security.secret-canary.v1') return undefined;
  const separator = row.preconditionState.indexOf('-scanned-in-');
  const secretClass = row.preconditionState.slice(0, separator);
  const sink = row.preconditionState.slice(separator + '-scanned-in-'.length);
  const canary = secretCanary(secretClass, row);
  return Object.freeze({
    canary,
    sink,
    secretClass,
    input: Object.freeze({
      event: sink,
      secretClass,
      payload: canary,
      context: Object.freeze({ diagnostic: canary }),
    }),
  });
};

let secretBoundaryProduction;

const loadSecretBoundaryProduction = async () => {
  if (secretBoundaryProduction !== undefined) return secretBoundaryProduction;
  const httpFilterLoader = register({
    namespace: 'security-http-filter-certification',
    tsconfig: new URL('../../../sceneboard-be/tsconfig.json', import.meta.url).pathname,
  });
  const [
    { dispatchBackendSecretSinkV1 },
    { rejectArtifactSecretSinkV1 },
    { observeMandatoryAuditWriteV1 },
    { SafeStderrLoggerV1 },
    { toolFailureV1 },
    { HttpErrorFilter },
  ] = await Promise.all([
    tsImport(
      '../../../sceneboard-be/src/common/security/secret-sink-observability.ts',
      import.meta.url,
      { tsconfig: '../../../sceneboard-be/tsconfig.json' },
    ),
    tsImport(
      '../../../packages/artifact-runtime/src/policy/secret-sink-observability.ts',
      import.meta.url,
      { tsconfig: '../../../packages/artifact-runtime/tsconfig.json' },
    ),
    tsImport('../../../sceneboard-be/src/audit/audit.repository.ts', import.meta.url, {
      tsconfig: '../../../sceneboard-be/tsconfig.json',
    }),
    tsImport('../../../sceneboard-mcp/src/diagnostics/safe-logger.ts', import.meta.url),
    tsImport('../../../sceneboard-mcp/src/tools/tool-result.ts', import.meta.url, {
      tsconfig: '../../../sceneboard-mcp/tsconfig.json',
    }),
    httpFilterLoader.import(
      '../../../sceneboard-be/src/common/filters/http-error.filter.ts',
      import.meta.url,
    ),
  ]);
  await httpFilterLoader.unregister();
  const { CertificationEvidenceWriter } = await import('./evidence-writer.mjs');
  secretBoundaryProduction = Object.freeze({
    CertificationEvidenceWriter,
    HttpErrorFilter,
    SafeStderrLoggerV1,
    dispatchBackendSecretSinkV1,
    observeMandatoryAuditWriteV1,
    rejectArtifactSecretSinkV1,
    toolFailureV1,
  });
  return secretBoundaryProduction;
};

const serialize = (value) => JSON.stringify(value);

const secretSinkEntrypoints = Object.freeze({
  APPLICATION_LOG: 'dispatchBackendSecretSinkV1',
  METRIC: 'dispatchBackendSecretSinkV1',
  ERROR: 'HttpErrorFilter.catch',
  AUDIT: 'AuditRepository.writeMandatory',
  MCP_STDOUT_OR_TOOL_CONTENT: 'toolFailureV1',
  MCP_STDERR_OR_DIAGNOSTIC: 'SafeStderrLoggerV1.log',
  HTTP_RESPONSE_OR_URL: 'HttpErrorFilter.catch',
  DOM: 'rejectArtifactSecretSinkV1',
  BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER: 'rejectArtifactSecretSinkV1',
  SCREENSHOT_TRACE_OR_VIDEO: 'rejectArtifactSecretSinkV1',
  RETRY_QUEUE_OR_OUTBOX: 'dispatchBackendSecretSinkV1',
  CERTIFICATION_RECORD_OR_ATTACHMENT: 'CertificationEvidenceWriter.writeAttachment',
});

const secretSinkProductionWiring = Object.freeze({
  APPLICATION_LOG: Object.freeze([
    ['sceneboard-be/src/events/outbox-dispatcher.service.ts', 'dispatchBackendSecretSinkV1'],
  ]),
  METRIC: Object.freeze([
    ['sceneboard-be/src/sse/board-stream-health.service.ts', 'dispatchBackendSecretSinkV1'],
  ]),
  ERROR: Object.freeze([
    ['sceneboard-be/src/common/filters/http-error.filter.ts', "sink: 'ERROR'"],
  ]),
  AUDIT: Object.freeze([['sceneboard-be/src/audit/audit.repository.ts', 'writeMandatory(']]),
  HTTP_RESPONSE_OR_URL: Object.freeze([
    ['sceneboard-be/src/common/filters/http-error.filter.ts', "sink: 'HTTP_RESPONSE_OR_URL'"],
  ]),
  DOM: Object.freeze([
    ['packages/artifact-runtime/src/bridge/endpoint.ts', 'rejectArtifactSecretSinkV1'],
    ['packages/board-ui/src/artifact/use-artifact-bridge.ts', 'rejectSecretSink('],
  ]),
  BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER: Object.freeze([
    ['packages/artifact-runtime/src/bridge/endpoint.ts', 'rejectArtifactSecretSinkV1'],
    ['packages/board-ui/src/artifact/use-artifact-bridge.ts', 'rejectSecretSink('],
  ]),
  SCREENSHOT_TRACE_OR_VIDEO: Object.freeze([
    ['packages/artifact-runtime/src/bridge/endpoint.ts', 'rejectArtifactSecretSinkV1'],
    ['packages/board-ui/src/artifact/use-artifact-bridge.ts', 'rejectSecretSink('],
  ]),
  RETRY_QUEUE_OR_OUTBOX: Object.freeze([
    ['sceneboard-be/src/events/board-event-outbox.repository.ts', "sink: 'RETRY_QUEUE_OR_OUTBOX'"],
  ]),
});

const assertSecretSinkProductionWiring = async (sink) => {
  const requirements = secretSinkProductionWiring[sink];
  if (requirements === undefined) return;
  for (const [path, token] of requirements) {
    const source = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    assert.ok(source.includes(token), `production secret sink wiring missing: ${sink}:${path}`);
  }
};

const streamCapture = async (write) => {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await write(stream);
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(chunks);
};

export const validateHttpErrorSinkCaptureV1 = ({ sink, canary, errorRecords, responseBytes }) => {
  assert.ok(sink === 'ERROR' || sink === 'HTTP_RESPONSE_OR_URL', 'HTTP sink is fixed');
  assert.equal(typeof canary, 'string', 'HTTP sink canary is required');
  assert.ok(Array.isArray(errorRecords), 'ERROR record capture is required');
  assert.ok(Array.isArray(responseBytes), 'HTTP response capture is required');
  assert.equal(errorRecords.length, 1, 'ERROR sink must emit exactly one record');
  const errorRecord = errorRecords[0];
  assert.equal(typeof errorRecord, 'string', 'ERROR sink record must preserve exact text bytes');
  assert.equal(errorRecord.includes(canary), false, 'secret canary reached ERROR');
  const parsed = JSON.parse(errorRecord);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['details', 'message', 'name'],
    'ERROR sink record shape diverged',
  );
  assert.equal(parsed.name, 'SafeOperationalError', 'ERROR sink name diverged');
  assert.equal(parsed.message, 'Operation failed', 'ERROR sink message diverged');
  assert.ok(
    parsed.details !== null && typeof parsed.details === 'object' && !Array.isArray(parsed.details),
    'ERROR sink details diverged',
  );

  if (sink === 'ERROR') return errorRecords.map((record) => Buffer.from(record, 'utf8'));
  assert.ok(responseBytes.length > 0, 'HTTP response adapter capture is incomplete');
  return responseBytes;
};

const captureHttpErrorFilterOutput = ({ HttpErrorFilter, input, sink, canary }) => {
  const requestUrl =
    sink === 'ERROR' ? '/certification/security-error' : '/certification/security-http-response';
  const headers = [];
  const statuses = [];
  const bodies = [];
  const errorRecords = [];
  const response = {
    setHeader(name, value) {
      headers.push([name, value]);
      return this;
    },
    status(statusCode) {
      statuses.push(statusCode);
      return this;
    },
    json(value) {
      bodies.push(value);
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url: requestUrl }),
      getResponse: () => response,
    }),
  };
  const exception = new Error('certification HTTP error', { cause: input });
  assert.equal(exception.cause, input, 'HTTP error canary did not enter the production entrypoint');
  new HttpErrorFilter(
    { generatePublicIdV1: () => 'certification-request-id' },
    { observe: (record) => errorRecords.push(record) },
  ).catch(exception, host);
  assert.equal(statuses.length, 1, 'HTTP error status capture is incomplete');
  assert.equal(bodies.length, 1, 'HTTP error body capture is incomplete');
  assert.ok(headers.length > 0, 'HTTP error header capture is incomplete');
  assert.equal(statuses[0], 500, 'HTTP error status capture diverged');
  assert.deepEqual(
    headers,
    [['X-Request-Id', 'certification-request-id']],
    'HTTP error header capture diverged',
  );
  assert.deepEqual(
    bodies[0],
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    'HTTP error body capture diverged',
  );
  for (const [name, value] of headers) {
    assert.equal(typeof name, 'string', 'HTTP error header name capture diverged');
    assert.equal(typeof value, 'string', 'HTTP error header value capture diverged');
  }
  const responseBytes = [
    Buffer.from(String(statuses[0]), 'utf8'),
    ...headers.flatMap(([name, value]) => [Buffer.from(name, 'utf8'), Buffer.from(value, 'utf8')]),
    Buffer.from(requestUrl, 'utf8'),
    Buffer.from(serialize(bodies[0]), 'utf8'),
  ];
  const bytes = validateHttpErrorSinkCaptureV1({
    sink,
    canary,
    errorRecords,
    responseBytes,
  });
  return {
    bytes,
    captureBinding: Object.freeze({
      capturedRecordSha256: Object.freeze(bytes.map((value) => sha256(value))),
      producerEntrypoint: 'HttpErrorFilter.catch',
      recordCount: bytes.length,
      requestedSink: sink,
    }),
    disposition: 'SANITIZED',
    observedRecords: bytes.length,
    producerEntrypoint: 'HttpErrorFilter.catch',
    sink,
  };
};

const collectSecretSinkOutput = async ({ sink, input, row, cleanup }) => {
  await assertSecretSinkProductionWiring(sink);
  const {
    CertificationEvidenceWriter,
    HttpErrorFilter,
    SafeStderrLoggerV1,
    dispatchBackendSecretSinkV1,
    observeMandatoryAuditWriteV1,
    rejectArtifactSecretSinkV1,
    toolFailureV1,
  } = await loadSecretBoundaryProduction();
  if (sink === 'ERROR' || sink === 'HTTP_RESPONSE_OR_URL') {
    return captureHttpErrorFilterOutput({ HttpErrorFilter, input, sink, canary: input.payload });
  }
  if (sink === 'APPLICATION_LOG' || sink === 'METRIC' || sink === 'RETRY_QUEUE_OR_OUTBOX') {
    const bytes = [];
    const result = dispatchBackendSecretSinkV1({
      sink,
      rawPayload: input,
      observer: { observe: (value) => bytes.push(Buffer.from(value, 'utf8')) },
    });
    return { bytes, ...result };
  }
  if (sink === 'AUDIT') {
    const bytes = [];
    try {
      await observeMandatoryAuditWriteV1({
        input: {
          event: 'export.started',
          userPublicId: null,
          sessionPublicId: null,
          subjectFingerprint: Buffer.from('certification'),
          metadata: input,
        },
        observe: (sql, parameters) => {
          bytes.push(Buffer.from(sql, 'utf8'), Buffer.from(serialize(parameters), 'utf8'));
        },
      });
      throw new Error('audit producer admitted a secret-bearing metadata field');
    } catch (error) {
      if (!String(error?.message).includes('audit metadata key is not allowed')) throw error;
      return {
        bytes,
        disposition: 'REJECTED_POLICY',
        observedRecords: bytes.length,
        producerEntrypoint: 'AuditRepository.writeMandatory',
        sink,
      };
    }
  }
  if (
    sink === 'DOM' ||
    sink === 'BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER' ||
    sink === 'SCREENSHOT_TRACE_OR_VIDEO'
  ) {
    const bytes = [];
    const result = rejectArtifactSecretSinkV1({
      sink,
      rawPayload: input,
      observer: { observe: (value) => bytes.push(Buffer.from(value, 'utf8')) },
    });
    return { bytes, ...result };
  }
  if (sink === 'CERTIFICATION_RECORD_OR_ATTACHMENT') {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sceneboard-evidence-capture-'));
    cleanup.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const writer = await CertificationEvidenceWriter.create({
      workspaceRoot,
      sourceCommit: 'a'.repeat(40),
      manifestSha256: 'b'.repeat(64),
      profile: 'test',
      attemptId: `canary-${row.caseId.toLowerCase()}`,
    });
    try {
      await writer.writeAttachment(
        writer.ownerToken,
        Buffer.from(serialize(input)),
        'application/json',
      );
      throw new Error('certification producer admitted a secret-bearing attachment');
    } catch (error) {
      if (error?.code !== 'EVIDENCE_SECRET_CANARY_MATCH') throw error;
    }
    const attachmentNames = await readdir(join(writer.attemptRoot, 'attachments'));
    if (attachmentNames.length !== 0)
      throw new Error('certification producer retained a rejected attachment');
    return {
      bytes: [Buffer.from('EVIDENCE_SECRET_CANARY_MATCH'), Buffer.from(serialize(attachmentNames))],
      disposition: 'REJECTED_POLICY',
      observedRecords: 2,
      producerEntrypoint: 'CertificationEvidenceWriter.writeAttachment',
      sink,
    };
  }
  if (sink === 'MCP_STDOUT_OR_TOOL_CONTENT') {
    const bytes = [
      await streamCapture(async (stream) => {
        stream.write(serialize(toolFailureV1('board_get', 'certification-request', 'mcp', input)));
      }),
    ];
    return {
      bytes,
      disposition: 'SANITIZED',
      observedRecords: bytes.length,
      producerEntrypoint: 'toolFailureV1',
      sink,
    };
  }
  if (sink === 'MCP_STDERR_OR_DIAGNOSTIC') {
    const lines = [];
    new SafeStderrLoggerV1((line) => lines.push(Buffer.from(line))).log({
      event: 'security_canary',
      ...input,
    });
    return {
      bytes: lines,
      disposition: 'SANITIZED',
      observedRecords: lines.length,
      producerEntrypoint: 'SafeStderrLoggerV1.log',
      sink,
    };
  }
  throw new Error(`unsupported secret sink transport: ${sink}`);
};

const adapterBrand = Symbol('repository-security-input-adapter');

const createAuthorityReceipt = ({
  row,
  identity,
  producer,
  observedCodeOrState,
  operationTranscript,
  executionNonce,
}) => {
  assert.equal(typeof executionNonce, 'string');
  assert.ok(Buffer.byteLength(executionNonce, 'utf8') >= 32);
  const nonce = Buffer.from(executionNonce, 'utf8');
  const payload = {
    schemaVersion: 2,
    executorId: producer.producerId,
    implementationIdentity: producer.implementationIdentity,
    implementationSha256: producer.implementationIdentity.implementationSha256,
    identitySha256: sha256(canonicalJson(identity)),
    attemptId: identity.attemptId,
    caseId: row.caseId,
    observedCodeOrState,
    status: 'PASS',
    cleanupStatus: 'PASS',
    operationTranscript,
    operationSha256: sha256(canonicalJson(operationTranscript)),
    executionNonceSha256: sha256(nonce),
    observedAt: new Date().toISOString(),
  };
  const bytes = Buffer.from(`${canonicalJson(payload)}\n`, 'utf8');
  return Object.freeze({
    ...payload,
    authenticationSha256: createHmac('sha256', nonce).update(bytes).digest('hex'),
  });
};

const bindInputAdapter = async ({ definition, adapter, executeBoundary }) => {
  const producer = securityProducerDefinition(definition);
  assert.equal(adapter.name, producer.adapterEntrypoint, 'the producer input adapter is fixed');
  const sourceIdentity = producer.implementationIdentity.sourceFiles.find(
    ({ path }) => path === producer.testFile,
  );
  assert.ok(sourceIdentity, `the implementation identity must include ${producer.testFile}`);
  const sourceBytes = await readFile(new URL(`../../../${producer.testFile}`, import.meta.url));
  assert.equal(
    sha256(sourceBytes),
    sourceIdentity.sha256,
    'the input adapter source must be current',
  );
  const callableSource = Function.prototype.toString.call(adapter);
  assert.ok(
    sourceBytes
      .toString('utf8')
      .includes(`const ${producer.adapterEntrypoint} = ${callableSource}`),
    `the fixed input adapter declaration is missing from ${producer.testFile}`,
  );
  if (producer.producerId !== 'sceneboard.security.secret-canary.v1') {
    assert.equal(typeof executeBoundary, 'function', 'the production boundary executor is fixed');
    assert.ok(
      sourceBytes.toString('utf8').includes(`const ${executeBoundary.name} =`),
      `the production boundary executor declaration is missing from ${producer.testFile}`,
    );
  }
  return Object.freeze({
    [adapterBrand]: true,
    adapter,
    producer,
    callableSha256: sha256(callableSource),
    executeBoundary,
  });
};

const inertScenarioKeys = Object.freeze([
  'caseId',
  'cluster',
  'preconditionState',
  'principalKind',
]);

const readInertScenario = async (row, binding) => {
  const scenario = await binding.adapter(row);
  assert.deepEqual(
    Object.keys(scenario),
    inertScenarioKeys,
    'security adapters may provide inert scenario values only',
  );
  assert.deepEqual(scenario, {
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });
  return scenario;
};

const executeClosedProducerEffect = async ({ row, binding, registerOwnerResource, operate }) => {
  await readInertScenario(row, binding);
  if (process.env.SCENEBOARD_SECURITY_SUBSTITUTE_EFFECT === row.caseId)
    throw new Error(`injected production boundary substitution: ${row.caseId}`);
  return binding.executeBoundary(row, { registerOwnerResource, operate });
};

const closedProducerDispatch = Object.freeze(
  Object.fromEntries(
    [
      'sceneboard.security.auth-session-pairing.v1',
      'sceneboard.security.authorization-cross-board.v1',
      'sceneboard.security.hitl-race.v1',
      'sceneboard.security.artifact-boundary.v1',
      'sceneboard.security.hostile-payload.v1',
      'sceneboard.security.mcp-registry.v1',
    ].map((producerId) => [producerId, executeClosedProducerEffect]),
  ),
);

export const securityRequiredOwners = (rows) =>
  Object.freeze(
    [
      ...new Set(
        rows.flatMap((row) => {
          return ownerRegistry[row.producerId]?.[row.cluster]?.(row) ?? [];
        }),
      ),
    ].sort((left, right) => left.localeCompare(right, 'en')),
  );

export const executeSecurityBoundaryProducer = async ({
  row,
  identity,
  executionNonce,
  binding,
}) => {
  assert.equal(binding?.[adapterBrand], true, `fixed producer binding required for ${row.caseId}`);
  const expectedProducer = binding.producer;
  assert.equal(row.producerId, expectedProducer.producerId);
  assert.equal(row.producerEntrypoint, expectedProducer.implementationIdentity.entrypoint);
  assert.equal(row.testFile, expectedProducer.testFile);
  assert.equal(row.cluster, expectedProducer.cluster);
  assert.equal(binding.producer.producerId, expectedProducer.producerId);
  assert.equal(binding.producer.cluster, expectedProducer.cluster);
  const requiredOwners = ownerRegistry[expectedProducer.producerId]?.[row.cluster]?.(row);
  assert.ok(Array.isArray(requiredOwners) && requiredOwners.length > 0);
  assert.equal(new Set(requiredOwners).size, requiredOwners.length);

  const operationTranscript = [`fixture-created:${identity.attemptId}:${row.caseId}`];
  operationTranscript.push(
    `producer-bound:${expectedProducer.producerId}:${expectedProducer.implementationIdentity.implementationSha256}:${binding.callableSha256}`,
  );
  const ownedResources = new Map();
  const registerOwnerResource = ({ owner, resource, cleanup, inspectResidue }) => {
    assert.ok(requiredOwners.includes(owner), `owner ${owner} is not required for ${row.caseId}`);
    assert.equal(
      [...ownedResources.values()].some((owned) => owned.owner === owner),
      false,
      `semantic owner ${owner} was registered more than once`,
    );
    assert.equal(typeof cleanup, 'function');
    assert.equal(typeof inspectResidue, 'function');
    const handle = Symbol(owner);
    ownedResources.set(handle, {
      owner,
      resource,
      cleanup,
      inspectResidue,
      entryCount: 0,
      operationCount: 0,
    });
    return handle;
  };
  const operate = async (handle, operation, invocation) => {
    const owned = ownedResources.get(handle);
    assert.ok(owned, 'operation requires a fixed producer-owned resource');
    assert.match(operation, /^[a-z][a-z0-9.-]+$/u);
    assert.equal(typeof invocation, 'function');
    owned.entryCount += 1;
    operationTranscript.push(`owner-entered:${sha256(`${owned.owner}:${operation}`)}`);
    if (process.env.SCENEBOARD_SECURITY_FAULT_OWNER === owned.owner)
      throw new Error(`injected production owner fault: ${owned.owner}`);
    try {
      const observed = await invocation(owned.resource);
      owned.operationCount += 1;
      operationTranscript.push(
        `operation-executed:${sha256(`${owned.owner}:${operation}`)}:${sha256(
          canonicalJson(semanticObservation(observed)),
        )}`,
      );
      return observed;
    } catch (error) {
      owned.operationCount += 1;
      operationTranscript.push(
        `operation-rejected:${sha256(`${owned.owner}:${operation}`)}:${sha256(
          canonicalJson({
            name: error instanceof Error ? error.name : 'NonError',
            code:
              error !== null && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : null,
          }),
        )}`,
      );
      throw error;
    }
  };
  let observedCodeOrState;
  let executionError;
  try {
    const attemptInput = producerAttemptInput(row, expectedProducer.producerId);
    if (expectedProducer.producerId === 'sceneboard.security.secret-canary.v1') {
      const scenario = await binding.adapter(row);
      assert.deepEqual(Object.keys(scenario), ['transportOnlyCanaryAllowance']);
      assert.deepEqual(
        scenario.transportOnlyCanaryAllowance,
        row.transportOnlyCanaryAllowance,
        'the inert adapter input must preserve the catalog allowance',
      );
      const isMcpSink = attemptInput.sink.startsWith('MCP_');
      const redactorOwner = isMcpSink
        ? 'sceneboard.mcp-secret-sink'
        : 'sceneboard.backend-secret-sink';
      const redactorResource = { effects: new Set() };
      const redactorHandle = registerOwnerResource({
        owner: redactorOwner,
        resource: redactorResource,
        cleanup: ({ effects }) => effects.clear(),
        inspectResidue: () => redactorResource.effects.size,
      });
      const transportOwner = `sceneboard.secret-transport.${attemptInput.sink
        .toLowerCase()
        .replaceAll('_', '-')}`;
      const transportResource = { scannedOutputHashes: new Set(), cleanup: [] };
      const transportHandle = registerOwnerResource({
        owner: transportOwner,
        resource: transportResource,
        cleanup: async ({ scannedOutputHashes, cleanup }) => {
          const failures = [];
          for (const operation of cleanup.reverse()) {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          }
          cleanup.length = 0;
          scannedOutputHashes.clear();
          if (failures.length > 0) throw new AggregateError(failures, 'secret sink cleanup failed');
        },
        inspectResidue: () =>
          transportResource.scannedOutputHashes.size + transportResource.cleanup.length,
      });
      operationTranscript.push(`raw-canary-authorized:${sha256(attemptInput.canary)}`);
      observedCodeOrState = await operate(
        redactorHandle,
        'secret.redactor.handle-canary',
        ({ effects }) => {
          effects.add(`handled:${attemptInput.secretClass}`);
          return operate(
            transportHandle,
            `secret.transport.${attemptInput.sink.toLowerCase().replaceAll('_', '-')}`,
            async ({ scannedOutputHashes, cleanup }) => {
              const output = await collectSecretSinkOutput({
                sink: attemptInput.sink,
                input: attemptInput.input,
                row,
                cleanup,
              });
              assert.equal(
                output.producerEntrypoint,
                secretSinkEntrypoints[attemptInput.sink],
                'closed production sink dispatch is required',
              );
              assert.equal(output.sink, attemptInput.sink);
              if (attemptInput.sink === 'ERROR' || attemptInput.sink === 'HTTP_RESPONSE_OR_URL') {
                assert.deepEqual(output.captureBinding, {
                  capturedRecordSha256: output.bytes.map((value) => sha256(value)),
                  producerEntrypoint: 'HttpErrorFilter.catch',
                  recordCount: output.bytes.length,
                  requestedSink: attemptInput.sink,
                });
                if (attemptInput.sink === 'ERROR') assert.equal(output.bytes.length, 1);
                operationTranscript.push(
                  `http-sink-capture-bound:${sha256(canonicalJson(output.captureBinding))}`,
                );
              }
              assert.ok(
                output.disposition === 'SANITIZED' ||
                  output.disposition === 'REJECTED_POLICY' ||
                  output.disposition === 'REJECTED_UNSUPPORTED',
                'production sink disposition is invalid',
              );
              assert.ok(
                Array.isArray(output.bytes) && output.bytes.length > 0,
                'sink capture is incomplete',
              );
              assert.equal(output.observedRecords, output.bytes.length);
              for (const value of output.bytes) {
                assert.ok(Buffer.isBuffer(value), 'sink capture must preserve exact bytes');
                assert.equal(
                  value.includes(attemptInput.canary),
                  false,
                  `secret canary reached ${attemptInput.sink}`,
                );
                scannedOutputHashes.add(sha256(value));
              }
              operationTranscript.push(
                `production-sink-observed:${attemptInput.sink}:${output.producerEntrypoint}:${output.disposition}`,
              );
              operationTranscript.push(
                `post-producer-bytes-scanned:${attemptInput.sink}:${output.bytes.length}`,
              );
              return 'ZERO_UNAPPROVED_OCCURRENCES';
            },
          );
        },
      );
    } else {
      const dispatch = closedProducerDispatch[expectedProducer.producerId];
      assert.equal(
        typeof dispatch,
        'function',
        `closed producer dispatch missing for ${row.caseId}`,
      );
      observedCodeOrState = await dispatch({
        row,
        binding,
        requiredOwners,
        registerOwnerResource,
        operate,
      });
    }
    operationTranscript.push(`boundary-observed:${observedCodeOrState}`);
  } catch (error) {
    executionError = error;
  }
  const cleanupErrors = [];
  for (const owned of [...ownedResources.values()].reverse()) {
    try {
      await owned.cleanup(owned.resource);
      assert.equal(
        await owned.inspectResidue(),
        0,
        `production owner ${owned.owner} left fixture residue`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (executionError) throw executionError;
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'production owner cleanup verification failed');
  assert.deepEqual(
    [...ownedResources.values()].map(({ owner }) => owner).sort(),
    [...requiredOwners].sort(),
  );
  for (const owned of ownedResources.values()) {
    assert.ok(owned.entryCount > 0, `production owner ${owned.owner} was not entered`);
    assert.ok(owned.operationCount > 0, `production owner ${owned.owner} was not invoked`);
  }
  assert.equal(observedCodeOrState, row.expectedCodeOrState);
  operationTranscript.push('cleanup-verified:zero-owned-residue');
  return createAuthorityReceipt({
    row,
    identity,
    producer: expectedProducer,
    observedCodeOrState,
    operationTranscript,
    executionNonce,
  });
};

export const registerSecurityBoundaryProducerRows = async ({
  producerId,
  expectedCounts,
  adapter,
  executeBoundary,
  runtimeGapReason = () => null,
}) => {
  assert.equal(typeof adapter, 'function', 'the fixed producer input adapter is required');
  if (producerId !== 'sceneboard.security.secret-canary.v1')
    assert.equal(
      typeof executeBoundary,
      'function',
      'the production boundary executor is required',
    );
  assert.equal(typeof runtimeGapReason, 'function');
  const result = await validateSecurityCatalog(catalog);
  assert.equal(result.status, 'PASS');
  assert.equal(result.liveEvidenceStatus, 'BLOCKED');
  assert.equal(validateSecurityProducerMappings(catalog).status, 'PASS');
  const rows = catalog.cases.filter((row) => row.producerId === producerId);
  assert.ok(rows.length > 0, `unknown security producer: ${producerId}`);
  const clusters = Object.keys(expectedCounts);
  assert.equal(
    rows.length,
    Object.values(expectedCounts).reduce((sum, count) => sum + count, 0),
  );
  for (const [cluster, count] of Object.entries(expectedCounts))
    assert.equal(rows.filter((row) => row.cluster === cluster).length, count);
  assert.deepEqual([...new Set(rows.map(({ cluster }) => cluster))].sort(), [...clusters].sort());

  const bindings = new Map();
  for (const cluster of clusters) {
    const representative = rows.find((row) => row.cluster === cluster);
    bindings.set(
      cluster,
      await bindInputAdapter({ definition: representative, adapter, executeBoundary }),
    );
  }
  const receiptDirectory = process.env.SCENEBOARD_SECURITY_RECEIPT_DIRECTORY;
  const executionNonce =
    process.env.SCENEBOARD_SECURITY_EXECUTION_NONCE ??
    'security-boundary-owner-test-nonce-material-v1';
  const identity = receiptDirectory
    ? {
        sourceCommit: process.env.SCENEBOARD_CERTIFICATION_SOURCE_COMMIT,
        manifestSha256: process.env.SCENEBOARD_CERTIFICATION_MANIFEST_SHA256,
        profile: process.env.SCENEBOARD_CERTIFICATION_PROFILE,
        environment: process.env.APP_ENV,
        attemptId: process.env.SCENEBOARD_CERTIFICATION_ATTEMPT_ID,
      }
    : {
        sourceCommit: 'a'.repeat(40),
        manifestSha256: 'b'.repeat(64),
        profile: 'non-production',
        environment: 'test',
        attemptId: `owner-test-${sha256(producerId).slice(0, 16)}`,
      };
  const receipts = new Map();
  for (const row of rows) {
    test(`authenticated boundary execution: ${row.caseId}`, async (context) => {
      assert.equal(row.evidenceClass, 'live-required');
      assert.equal(row.evidenceRowId, `SEC-${row.caseId}`);
      assert.equal(row.cleanupAssertion, 'exact-owned-fixture-clean');
      const gap = await runtimeGapReason(row);
      if (gap !== null) {
        assert.equal(typeof gap, 'string');
        context.skip(gap);
        return;
      }
      receipts.set(
        row.caseId,
        await executeSecurityBoundaryProducer({
          row,
          identity,
          executionNonce,
          binding: bindings.get(row.cluster),
        }),
      );
    });
  }
  after(async () => {
    if (!receiptDirectory) return;
    assert.equal(receipts.size, rows.length);
    const value = {
      schemaVersion: 2,
      producerId,
      receipts: rows.map((row) => receipts.get(row.caseId)),
    };
    await writeFile(
      join(receiptDirectory, `${sha256(rows[0].testFile)}.json`),
      `${canonicalJson(value)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
  });
};
