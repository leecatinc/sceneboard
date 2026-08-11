import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_API_KEY_SCOPES,
  ARTIFACT_CAPABILITIES,
  BOARD_AUTHORIZATION_CAPABILITIES,
  BOARD_LIMITS,
  CAPABILITY_SCOPES,
  COMMAND_TYPES,
  EVENT_TYPES,
  HITL_KINDS,
  NODE_TYPES,
  OPERATION_TYPES,
  SESSION_LIFECYCLE_PERMISSIONS,
} from "../scripts/sceneboard-api-contract.mjs";
import { parseConnection } from "../scripts/sceneboard-api-public.mjs";
import { projectBoardEnvelope } from "../scripts/sceneboard-api-response.mjs";

const expandedScopes = [
  "artifact:control",
  "artifact:publish",
  "board:archive",
  "board:create",
  "board:hitl:request",
  "board:hitl:respond",
  "board:media:write",
  "board:read",
  "board:write",
  "export:read",
  "history:read",
];

test("accepts an API-key connection with the complete owner scope catalog", () => {
  assert.deepEqual(ACCOUNT_API_KEY_SCOPES, expandedScopes);

  const connection = parseConnection(
    {
      principal: {
        principalKind: "service",
        principalId: "service_key_1",
        grantId: null,
      },
      credential: {
        keyPublicId: "service_key_1",
        scopes: expandedScopes,
        status: "active",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      selectedBoard: null,
      versions: {
        mcpServer: "0.0.0",
        boardProtocol: "1.0.0",
        api: "v1",
      },
    },
    null,
    "api_key",
  );

  assert.deepEqual(connection?.credential.scopes, expandedScopes);
});

const requestId = "request_1";
const capabilities = {
  protocolVersion: 1,
  type: "board.capabilities",
  schemaVersion: "1.0.0",
  compatibilityMode: "frozen-major",
  supported: {
    nodeTypes: NODE_TYPES,
    commandTypes: COMMAND_TYPES,
    operationTypes: OPERATION_TYPES,
    eventTypes: EVENT_TYPES,
    hitlKinds: HITL_KINDS,
    artifactRequestCapabilities: ARTIFACT_CAPABILITIES,
  },
  limits: BOARD_LIMITS,
  grantedCapabilities: ["board.read"],
  allowedArtifactRequestCapabilities: [],
};
const sessionAccess = {
  protocolVersion: 1,
  type: "board.session.access",
  capabilityEpoch: 3,
  authorizationCapabilities: BOARD_AUTHORIZATION_CAPABILITIES,
  connectionGrantCeiling: {
    scopes: CAPABILITY_SCOPES,
    lifecyclePermissions: SESSION_LIFECYCLE_PERMISSIONS,
  },
};

const capabilitiesEnvelope = (sessionAccessValue) => ({
  protocolVersion: 1,
  type: "board.http.success",
  requestId,
  result: {
    protocolVersion: 1,
    type: "board.operation.result",
    requestId,
    replayed: false,
    result: {
      type: "capabilities.get",
      capabilities,
      ...(sessionAccessValue === undefined
        ? {}
        : { sessionAccess: sessionAccessValue }),
    },
  },
  metadata: { history: null },
});

const projectCapabilities = (value) =>
  projectBoardEnvelope(value, {
    requestId,
    expectedType: "capabilities.get",
    status: 200,
  });

test("accepts the current capabilities response with strict session access", () => {
  const result = projectCapabilities(capabilitiesEnvelope(sessionAccess));

  assert.deepEqual(result?.result.result.sessionAccess, sessionAccess);
});

test("rejects missing or malformed session access", () => {
  const extra = structuredClone(sessionAccess);
  extra.role = "owner";
  const reversed = structuredClone(sessionAccess);
  reversed.authorizationCapabilities = ["board.write", "board.read"];

  assert.equal(projectCapabilities(capabilitiesEnvelope(undefined)), null);
  assert.equal(projectCapabilities(capabilitiesEnvelope(extra)), null);
  assert.equal(projectCapabilities(capabilitiesEnvelope(reversed)), null);
});
