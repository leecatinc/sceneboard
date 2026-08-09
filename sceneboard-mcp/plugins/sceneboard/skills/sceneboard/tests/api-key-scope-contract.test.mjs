import assert from "node:assert/strict";
import test from "node:test";

import { ACCOUNT_API_KEY_SCOPES } from "../scripts/sceneboard-api-contract.mjs";
import { parseConnection } from "../scripts/sceneboard-api-public.mjs";

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
