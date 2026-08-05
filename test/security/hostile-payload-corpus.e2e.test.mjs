import { readFile } from 'node:fs/promises';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { tsImport } from 'tsx/esm/api';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const { FIXTURE_CATALOG } = await tsImport(
  '../../packages/board-schema/test/fixture-catalog.ts',
  import.meta.url,
);
const schema = await tsImport('../../packages/board-schema/src/index.ts', import.meta.url);
const { parseProfiledBody } = await tsImport(
  '../../sceneboard-be/src/common/http/raw-body-profiles.ts',
  import.meta.url,
);
process.env.SCENEBOARD_SCENARIO_EVALUATOR_LIBRARY = '1';
const { evaluateScenario } = await tsImport(
  '../../packages/board-schema/test/protocol-compatibility.test.ts',
  import.meta.url,
);
delete process.env.SCENEBOARD_SCENARIO_EVALUATOR_LIBRARY;

const canonicalParser = { parse: schema.canonicalizeJsonV1 };
const fixtureCatalog = new Map(FIXTURE_CATALOG.map((entry) => [entry.path, entry]));
const baseArtifactResource = {
  path: 'index.html',
  mediaType: 'text/html',
  sha256: 'a'.repeat(64),
  byteLength: 12,
};
const baseArtifactManifest = {
  protocolVersion: 1,
  type: 'artifact.manifest',
  artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
  entryPath: 'index.html',
  resources: [baseArtifactResource],
  requestedCapabilities: [],
};
const baseEvent = JSON.parse(
  await readFile(
    new URL(
      '../../packages/board-schema/test/fixtures/valid/event-hitl-updated.v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const exactJsonBytes = (value, byteLength) => {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > byteLength) throw new Error('carrier fixture exceeds target');
  return Buffer.from(`${json}${' '.repeat(byteLength - Buffer.byteLength(json))}`);
};

const parseAdapterBody = (carrier, body) =>
  parseProfiledBody(
    {
      method: 'POST',
      pathTemplate: `/certification/${carrier.toLowerCase()}`,
      kind: 'd1-adapter-body',
      bodyRequired: true,
    },
    {
      contentType: 'application/json',
      contentLength: String(body.byteLength),
      body,
    },
  ).parsedBody;

const parseRestBody = (carrier, body) =>
  parseProfiledBody(
    {
      method: 'POST',
      pathTemplate: `/certification/${carrier.toLowerCase()}`,
      kind: 'd2-rest-json-body',
      bodyRequired: true,
    },
    {
      contentType: 'application/json',
      contentLength: String(body.byteLength),
      body,
    },
  ).body;

const requireParsed = (result) => {
  if (!result.ok) throw new Error(result.error.code);
  return result.data.value;
};

const admitEnvelopeCarrier = (carrier, byteLength) => {
  let value;
  if (carrier === 'MCP_JSONRPC_FRAME')
    value = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
  else if (carrier === 'HITL_DEFINITION')
    value = { kind: 'info', title: 'Info', body: 'Read', acknowledgeLabel: 'OK' };
  else if (carrier === 'ARTIFACT_BRIDGE_CONTROL')
    value = { type: 'artifact.ready', artifactId: 'artifact_1' };
  else value = baseEvent;

  if (carrier === 'SSE_FRAME') {
    const prefix = 'data: ';
    const suffix = '\n\n';
    if (byteLength > schema.BOARD_LIMITS_V1.maxEnvelopeBytes) throw new Error('PAYLOAD_TOO_LARGE');
    const data = exactJsonBytes(value, byteLength - Buffer.byteLength(prefix + suffix));
    const frame = Buffer.concat([Buffer.from(prefix), data, Buffer.from(suffix)]);
    if (frame.byteLength !== byteLength) throw new Error('invalid SSE frame length');
    requireParsed(schema.BoardEventEnvelopeParserV1.parse(JSON.parse(data.toString('utf8'))));
    return;
  }

  const body = exactJsonBytes(value, byteLength);
  const parsed = parseAdapterBody(carrier, body);
  if (carrier === 'MCP_JSONRPC_FRAME') JSONRPCMessageSchema.parse(parsed);
  else if (carrier === 'HITL_DEFINITION')
    requireParsed(schema.HitlRequestDefinitionParserV1.parse(parsed));
  else if (carrier === 'ARTIFACT_BRIDGE_CONTROL') requireParsed(schema.canonicalizeJsonV1(parsed));
  else requireParsed(schema.BoardEventEnvelopeParserV1.parse(parsed));
};

const admitArtifactSource = (byteLength) => {
  const logical = { ...baseArtifactResource, byteLength };
  const body = exactJsonBytes(logical, Math.max(256, Buffer.byteLength(JSON.stringify(logical))));
  const parsed = parseProfiledBody(
    {
      method: 'POST',
      pathTemplate: '/certification/artifact-source',
      kind: 'd7-artifact-source-body',
      bodyRequired: true,
    },
    {
      contentType: 'application/json',
      contentLength: String(body.byteLength),
      body,
    },
  ).parsedBody;
  requireParsed(schema.ArtifactResourceParserV1.parse(parsed));
};

const admitCarrier = (carrier, limitName, byteLength) => {
  if (carrier === 'HTTP_JSON_BODY') {
    requireParsed(
      schema.canonicalizeJsonV1(
        parseAdapterBody(carrier, exactJsonBytes({ request: 'certify' }, byteLength)),
      ),
    );
    return;
  }
  if (
    carrier === 'MCP_JSONRPC_FRAME' ||
    carrier === 'SSE_FRAME' ||
    carrier === 'SSE_EVENT_DATA' ||
    carrier === 'ARTIFACT_BRIDGE_CONTROL' ||
    carrier === 'HITL_DEFINITION'
  ) {
    admitEnvelopeCarrier(carrier, byteLength);
    return;
  }
  if (carrier === 'ARTIFACT_SOURCE_BODY') {
    admitArtifactSource(byteLength);
    return;
  }
  if (carrier === 'ARTIFACT_RESOURCE') {
    requireParsed(schema.ArtifactResourceParserV1.parse({ ...baseArtifactResource, byteLength }));
    return;
  }
  if (carrier === 'ARTIFACT_TOTAL') {
    const resources = [
      { ...baseArtifactResource, byteLength: schema.BOARD_LIMITS_V1.maxArtifactResourceBytes },
      {
        ...baseArtifactResource,
        path: 'second.html',
        byteLength:
          schema.BOARD_LIMITS_V1.maxArtifactTotalBytes -
          schema.BOARD_LIMITS_V1.maxArtifactResourceBytes,
      },
    ];
    if (byteLength > schema.BOARD_LIMITS_V1.maxArtifactTotalBytes)
      resources.push({ ...baseArtifactResource, path: 'overflow.html', byteLength: 1 });
    requireParsed(
      schema.ArtifactManifestParserV1.parse({
        ...baseArtifactManifest,
        resources,
      }),
    );
    return;
  }
  if (carrier === 'HITL_RESPONSE') {
    const body = exactJsonBytes({ kind: 'info', acknowledged: true }, byteLength);
    requireParsed(schema.HitlResponseParserV1.parse(parseRestBody(carrier, body)));
    return;
  }
  throw new Error(`unsupported carrier ${carrier}:${limitName}`);
};

const executePayloadBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executePayloadProductionBoundary = async (row, fixture) => {
  const isHttpCarrier =
    row.preconditionState.startsWith('HTTP_') ||
    row.preconditionState.startsWith('ARTIFACT_SOURCE_BODY');
  const owner =
    row.cluster === 'SCHEMA_CORPUS'
      ? 'sceneboard.schema-evaluator'
      : isHttpCarrier
        ? 'sceneboard.http-carrier-admission'
        : 'sceneboard.contract-carrier-admission';
  const effects = new Set();
  const handle = fixture.registerOwnerResource({
    owner,
    resource: { effects },
    cleanup: ({ effects: ownedEffects }) => ownedEffects.clear(),
    inspectResidue: () => effects.size,
  });
  return fixture.operate(
    handle,
    `payload.${row.cluster.toLowerCase().replaceAll('_', '-')}`,
    async () => {
      if (row.cluster === 'CARRIER_BOUNDARY') {
        const match = /^(.*)-(max[A-Za-z]+)-(AT_LIMIT|ONE_OVER)$/u.exec(row.preconditionState);
        if (match === null) throw new Error(`invalid carrier boundary: ${row.preconditionState}`);
        const [, carrier, limitName, boundary] = match;
        const limit = schema.BOARD_LIMITS_V1[limitName];
        try {
          admitCarrier(carrier, limitName, boundary === 'AT_LIMIT' ? limit : limit + 1);
          effects.add(`carrier:${carrier}:accepted`);
          return 'CARRIER_ACCEPTED';
        } catch {
          effects.add(`carrier:${carrier}:rejected`);
          return 'PAYLOAD_TOO_LARGE_BEFORE_EFFECTS';
        }
      }
      if (row.cluster === 'SCHEMA_CORPUS') {
        const relative = row.preconditionState.replace('packages/board-schema/test/fixtures/', '');
        const entry = fixtureCatalog.get(relative);
        if (entry === undefined) throw new Error(`schema fixture is not registered: ${relative}`);
        const value = JSON.parse(
          await readFile(
            new URL(`../../packages/board-schema/test/fixtures/${relative}`, import.meta.url),
            'utf8',
          ),
        );
        if (entry.kind === 'scenario') {
          await evaluateScenario(value);
          effects.add(`scenario:${relative}:accepted`);
          return 'EXPECTED_SCHEMA_ACCEPTANCE_OR_SCENARIO';
        }
        const parser =
          entry.schema === 'CanonicalJsonParserV1' ? canonicalParser : schema[entry.schema];
        if (parser === undefined) throw new Error(`schema parser is not exported: ${entry.schema}`);
        const result = parser.parse(value);
        effects.add(`schema:${relative}:${result.ok}`);
        return entry.kind === 'invalid' && !result.ok
          ? 'EXPECTED_SCHEMA_REJECTION'
          : entry.kind === 'valid' && result.ok
            ? 'EXPECTED_SCHEMA_ACCEPTANCE_OR_SCENARIO'
            : 'SCHEMA_EXPECTATION_MISMATCH';
      }
      throw new Error(`unsupported payload boundary cluster: ${row.cluster}`);
    },
  );
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.hostile-payload.v1',
  expectedCounts: { CARRIER_BOUNDARY: 20, SCHEMA_CORPUS: 185 },
  adapter: executePayloadBoundary,
  executeBoundary: executePayloadProductionBoundary,
});
