import { createHash, randomBytes } from "node:crypto";

import {
  acquirePairingLock,
  deleteCredentialIfGeneration,
  getOrCreateInstallationId,
  readCredential,
  resolveApiConfig,
  TOKEN_PATTERN,
  writeCredential,
} from "./sceneboard-api-config.mjs";
import {
  ERROR_BODY_LIMIT,
  GLOBAL_ID_PATTERN,
  GRANT_SCOPES,
  LIFECYCLE_PERMISSIONS,
  OPERATION_ERROR_CODES,
  PAIRING_CODE_PATTERN,
  PAIRING_STATES,
  SUCCESS_BODY_LIMIT,
  validTimestamp,
} from "./sceneboard-api-contract.mjs";
import { SceneBoardApiError } from "./sceneboard-api-error.mjs";
import {
  hasExactKeys,
  isRecord,
  parseJsonBytes,
} from "./sceneboard-api-json.mjs";
import {
  assertExactInput,
  assertSortedCatalog,
  baseMutation,
  globalId,
  idempotencyKey,
  invalidInput,
  mutationSpec,
  protectedSpec,
} from "./sceneboard-api-request.mjs";
import {
  containsSecretValue,
  errorFromResponse,
  exactCatalog,
  parseConnection,
  parseRetryAfter,
  safeText,
  sanitizePublicValue,
  validClientName,
} from "./sceneboard-api-public.mjs";
import {
  projectBoardEnvelope,
  publicJsonTree,
} from "./sceneboard-api-response.mjs";
import { applyScenePatch } from "./sceneboard-scene-patch.mjs";

export {
  acquirePairingLock,
  applyScenePatch,
  assertSortedCatalog,
  deleteCredentialIfGeneration,
  getOrCreateInstallationId,
  readCredential,
  resolveApiConfig,
  SceneBoardApiError,
  writeCredential,
};

export const parseApiInputBytes = (bytes) => {
  try {
    return parseJsonBytes(bytes, "SceneBoard API fallback input", 1_048_576);
  } catch {
    throw new SceneBoardApiError(
      "INVALID_PAYLOAD",
      "SceneBoard API fallback input is invalid JSON",
      { exitCode: 2 },
    );
  }
};

const readBoundedBody = async (response, maximum, signal) => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new SceneBoardApiError(
          "BOARD_API_RESPONSE_INVALID",
          "SceneBoard response is invalid",
          {
            details: { reason: "body_too_large" },
          },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const sleep = (milliseconds, signal) =>
  new Promise((resolve) => {
    let finished = false;
    const done = (completed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), milliseconds);
    if (signal?.aborted) done(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });

export const requestJson = async ({
  config,
  path,
  method = "GET",
  body = null,
  authorization = null,
  requestId = null,
  expectedStatus,
  expectedType = null,
  allowedErrorCodes = null,
  retryKind = "none",
  requirePairingHeaders = null,
  correlation = null,
  connectionBoardId = undefined,
  connectionCredentialMode = "pairing",
  timeoutMs = config.timeoutMs,
  operationDeadline = null,
  fetchImpl = fetch,
}) => {
  const maximumAttempts =
    retryKind === "read" ? 3 : retryKind === "mutation" ? 2 : 1;
  const timeoutFailure = (phase) =>
    new SceneBoardApiError(
      "BOARD_API_TIMEOUT",
      "SceneBoard request timed out",
      {
        retryable: true,
        details: { phase },
      },
    );
  const deadline =
    operationDeadline === null
      ? performance.now() + timeoutMs
      : operationDeadline;
  const remainingAtStart = deadline - performance.now();
  if (!Number.isFinite(deadline) || remainingAtStart <= 0)
    throw timeoutFailure("request");
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1, Math.ceil(remainingAtStart)),
  );
  const sleepBeforeRetry = async (delay) => {
    if (
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay >= Math.max(0, deadline - performance.now())
    )
      throw timeoutFailure("retry");
    if (!(await sleep(delay, timeoutSignal))) throw timeoutFailure("retry");
  };
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (timeoutSignal.aborted) break;
    let response;
    try {
      response = await fetchImpl(new URL(path, config.baseUrl), {
        method,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          ...(authorization === null ? {} : { Authorization: authorization }),
          ...(requestId === null ? {} : { "X-Request-Id": requestId }),
          ...(body === null ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: timeoutSignal,
      });
    } catch {
      if (attempt < maximumAttempts && !timeoutSignal.aborted) {
        await sleepBeforeRetry(
          100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100),
        );
        continue;
      }
      throw new SceneBoardApiError(
        timeoutSignal.aborted
          ? "BOARD_API_TIMEOUT"
          : "BOARD_API_TRANSPORT_ERROR",
        timeoutSignal.aborted
          ? "SceneBoard request timed out"
          : "SceneBoard transport is unavailable",
        { retryable: true, details: { phase: "request" } },
      );
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError(
        "BOARD_API_RESPONSE_INVALID",
        "SceneBoard response is invalid",
        {
          details: { reason: "redirect" },
        },
      );
    }
    if (
      response.headers.get("content-type")?.toLowerCase() !==
      "application/json; charset=utf-8"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError(
        "BOARD_API_RESPONSE_INVALID",
        "SceneBoard response is invalid",
        {
          details: { reason: "content_type" },
        },
      );
    }
    if (
      requestId !== null &&
      response.headers.get("x-request-id") !== requestId
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new SceneBoardApiError(
        "BOARD_API_RESPONSE_INVALID",
        "SceneBoard response is invalid",
        {
          details: { reason: "correlation" },
        },
      );
    }
    if (requirePairingHeaders !== null) {
      const vary =
        requirePairingHeaders === "claim"
          ? null
          : requirePairingHeaders === "connection"
            ? "Origin, Cookie, Authorization"
            : "Authorization";
      if (
        response.headers.get("cache-control") !== "no-store, private" ||
        response.headers.get("pragma") !== "no-cache" ||
        response.headers.get("vary") !== vary
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new SceneBoardApiError(
          "BOARD_API_RESPONSE_INVALID",
          "SceneBoard pairing response is invalid",
          {
            details: { reason: "headers" },
          },
        );
      }
    }
    let bytes;
    try {
      bytes = await readBoundedBody(
        response,
        response.status >= 200 && response.status < 300
          ? SUCCESS_BODY_LIMIT
          : ERROR_BODY_LIMIT,
        timeoutSignal,
      );
    } catch (error) {
      if (error instanceof SceneBoardApiError) throw error;
      throw new SceneBoardApiError(
        timeoutSignal.aborted
          ? "BOARD_API_TIMEOUT"
          : "BOARD_API_TRANSPORT_ERROR",
        timeoutSignal.aborted
          ? "SceneBoard response timed out"
          : "SceneBoard response is unavailable",
        { retryable: true, details: { phase: "response" } },
      );
    }
    const parsed = parseJsonBytes(bytes, "SceneBoard response");
    if (!expectedStatus.includes(response.status)) {
      const responseError = errorFromResponse(
        parsed,
        response,
        ["claim", "status", "redeem"].includes(requirePairingHeaders),
        allowedErrorCodes,
      );
      const canRetry =
        attempt < maximumAttempts &&
        responseError.retryable &&
        ["RATE_LIMITED", "SERVICE_UNAVAILABLE"].includes(responseError.code);
      if (canRetry) {
        const retryAfterHeader = parseRetryAfter(response);
        if (retryAfterHeader === "invalid") {
          throw new SceneBoardApiError(
            "BOARD_API_RESPONSE_INVALID",
            "SceneBoard response is invalid",
            {
              details: { reason: "headers" },
            },
          );
        }
        const retryAfter =
          retryAfterHeader ?? Number(responseError.details?.retryAfterSeconds);
        const delay =
          Number.isSafeInteger(retryAfter) &&
          retryAfter >= 1 &&
          retryAfter <= 120
            ? retryAfter * 1_000
            : 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
        await sleepBeforeRetry(delay);
        continue;
      }
      throw responseError;
    }
    if (connectionBoardId !== undefined) {
      const connection = parseConnection(
        parsed,
        connectionBoardId,
        connectionCredentialMode,
      );
      if (connection === null) {
        throw new SceneBoardApiError(
          "BOARD_API_RESPONSE_INVALID",
          "SceneBoard connection response is invalid",
          {
            details: { reason: "schema" },
          },
        );
      }
      return connection;
    }
    if (expectedType !== null) {
      const projected = projectBoardEnvelope(parsed, {
        requestId,
        expectedType,
        status: response.status,
        correlation,
      });
      if (projected === null) {
        throw new SceneBoardApiError(
          "BOARD_API_RESPONSE_INVALID",
          "SceneBoard response is invalid",
          {
            details: { reason: "schema" },
          },
        );
      }
      return projected;
    }
    if (
      !["claim", "status", "redeem"].includes(requirePairingHeaders) &&
      !publicJsonTree(parsed)
    ) {
      throw new SceneBoardApiError(
        "BOARD_API_RESPONSE_INVALID",
        "SceneBoard response is invalid",
        {
          details: { reason: "secret_material" },
        },
      );
    }
    return parsed;
  }
  throw timeoutSignal.aborted
    ? timeoutFailure("request")
    : new SceneBoardApiError(
        "BOARD_API_TRANSPORT_ERROR",
        "SceneBoard transport is unavailable",
        {
          retryable: true,
        },
      );
};

export const validatePairInput = (input) => {
  assertExactInput(input, [
    "code",
    "clientName",
    "requestedScopes",
    "requestedLifecyclePermissions",
  ]);
  if (typeof input.code !== "string" || !PAIRING_CODE_PATTERN.test(input.code))
    invalidInput("code");
  if (!validClientName(input.clientName)) invalidInput("clientName");
  assertSortedCatalog(input.requestedScopes, GRANT_SCOPES, "requestedScopes");
  assertSortedCatalog(
    input.requestedLifecyclePermissions,
    LIFECYCLE_PERMISSIONS,
    "requestedLifecyclePermissions",
    true,
  );
  return { ...input, code: input.code.toUpperCase() };
};

const invalidPairingResponse = () => {
  throw new SceneBoardApiError(
    "BOARD_API_RESPONSE_INVALID",
    "SceneBoard pairing response is invalid",
  );
};

export const parsePairingClaim = (value) => {
  if (
    !hasExactKeys(value, [
      "pairingId",
      "state",
      "decisionExpiresAt",
      "pollAfterSeconds",
    ]) ||
    typeof value.pairingId !== "string" ||
    !GLOBAL_ID_PATTERN.test(value.pairingId) ||
    value.state !== "pending" ||
    !validTimestamp(value.decisionExpiresAt) ||
    value.pollAfterSeconds !== 2
  ) {
    invalidPairingResponse();
  }
  return value;
};

export const parsePairingStatus = (value, pairingId) => {
  if (
    !hasExactKeys(value, [
      "pairingId",
      "state",
      "retryAfterSeconds",
      "decisionExpiresAt",
      "redeemExpiresAt",
    ]) ||
    value.pairingId !== pairingId ||
    !PAIRING_STATES.includes(value.state) ||
    !validTimestamp(value.decisionExpiresAt) ||
    (value.redeemExpiresAt !== null && !validTimestamp(value.redeemExpiresAt))
  )
    invalidPairingResponse();
  if (value.state === "pending") {
    if (
      ![2, 5, 10].includes(value.retryAfterSeconds) ||
      value.redeemExpiresAt !== null
    )
      invalidPairingResponse();
  } else if (value.retryAfterSeconds !== null) invalidPairingResponse();
  if (
    ["approved", "redeemed"].includes(value.state) &&
    value.redeemExpiresAt === null
  )
    invalidPairingResponse();
  if (value.state === "denied" && value.redeemExpiresAt !== null)
    invalidPairingResponse();
  return value;
};

const parseRedeemedGrant = (grant) => {
  const scopes = exactCatalog(grant?.scopes, GRANT_SCOPES, 1);
  const lifecyclePermissions = exactCatalog(
    grant?.lifecyclePermissions,
    LIFECYCLE_PERMISSIONS,
  );
  if (
    !hasExactKeys(grant, [
      "grantId",
      "client",
      "scopes",
      "lifecyclePermissions",
      "boardIds",
      "lifetime",
      "status",
      "createdAt",
      "activatedAt",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
    ]) ||
    !hasExactKeys(grant.client, [
      "clientId",
      "clientName",
      "installationFingerprint",
    ]) ||
    typeof grant.grantId !== "string" ||
    !GLOBAL_ID_PATTERN.test(grant.grantId) ||
    typeof grant.client.clientId !== "string" ||
    !GLOBAL_ID_PATTERN.test(grant.client.clientId) ||
    !validClientName(grant.client.clientName) ||
    typeof grant.client.installationFingerprint !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/u.test(grant.client.installationFingerprint) ||
    scopes === null ||
    lifecyclePermissions === null ||
    !Array.isArray(grant.boardIds) ||
    grant.boardIds.length > 50 ||
    (grant.boardIds.length === 0 &&
      (!scopes.includes("board.write") ||
        !lifecyclePermissions.includes("board.create"))) ||
    grant.boardIds.some(
      (id) => typeof id !== "string" || !GLOBAL_ID_PATTERN.test(id),
    ) ||
    new Set(grant.boardIds).size !== grant.boardIds.length ||
    !["session", "persistent"].includes(grant.lifetime) ||
    grant.status !== "active" ||
    !validTimestamp(grant.createdAt) ||
    !validTimestamp(grant.activatedAt) ||
    (grant.lastUsedAt !== null && !validTimestamp(grant.lastUsedAt)) ||
    !validTimestamp(grant.expiresAt) ||
    grant.revokedAt !== null
  )
    invalidPairingResponse();
  return grant;
};

export const parsePairingRedeem = (value) => {
  if (
    !hasExactKeys(value, ["tokenType", "accessToken", "grant"]) ||
    value.tokenType !== "Bearer" ||
    typeof value.accessToken !== "string" ||
    !TOKEN_PATTERN.test(value.accessToken)
  )
    invalidPairingResponse();
  parseRedeemedGrant(value.grant);
  return value;
};

const sameOrderedValues = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const validatePairingAuthorization = (
  redeemed,
  connection,
  requested,
) => {
  const grant = redeemed?.grant;
  const authorized = connection?.grant;
  const principal = connection?.principal;
  if (
    !isRecord(grant) ||
    !isRecord(authorized) ||
    !isRecord(principal) ||
    !isRecord(grant.client) ||
    !isRecord(authorized.client) ||
    principal.principalKind !== "mcp_client" ||
    principal.principalId !== grant.client.clientId ||
    principal.grantId !== grant.grantId ||
    authorized.grantId !== grant.grantId ||
    authorized.client.clientId !== grant.client.clientId ||
    authorized.client.clientName !== grant.client.clientName ||
    authorized.client.installationFingerprint !==
      grant.client.installationFingerprint ||
    requested.clientName !== grant.client.clientName ||
    !sameOrderedValues(authorized.scopes, grant.scopes) ||
    !sameOrderedValues(
      authorized.lifecyclePermissions,
      grant.lifecyclePermissions,
    ) ||
    !sameOrderedValues(authorized.boardIds, grant.boardIds) ||
    !grant.scopes.every((scope) => requested.requestedScopes.includes(scope)) ||
    !grant.lifecyclePermissions.every((permission) =>
      requested.requestedLifecyclePermissions.includes(permission),
    ) ||
    authorized.lifetime !== grant.lifetime ||
    authorized.status !== grant.status ||
    authorized.activatedAt !== grant.activatedAt ||
    authorized.expiresAt !== grant.expiresAt
  )
    invalidPairingResponse();
  return true;
};

export const createPairingProof = () => {
  const bytes = randomBytes(32);
  return {
    bytes,
    value: bytes.toString("base64url"),
    challenge: createHash("sha256").update(bytes).digest("base64url"),
  };
};

const authorizedRequest = async (config, credential, options) => {
  try {
    return await requestJson({
      config,
      ...options,
      authorization: `Bearer ${credential.accessToken}`,
    });
  } catch (error) {
    if (
      credential.credentialMode === "pairing" &&
      error instanceof SceneBoardApiError &&
      error.code === "UNAUTHENTICATED"
    ) {
      try {
        await deleteCredentialIfGeneration(config, credential.generation);
      } catch {
        // Credential cleanup must not replace the authentication failure.
      }
    }
    throw error;
  }
};

const CREATED_SUCCESS_TYPES = new Set([
  "board.create",
  "scene.replace",
  "scene.clear",
  "hitl.request",
  "hitl.respond",
  "artifact.stop",
]);

export const invokeProtected = async (
  operation,
  input,
  { cwd, env, fetchImpl } = {},
) => {
  const config = await resolveApiConfig({ cwd, env });
  const requestId = randomBytes(16).toString("base64url");
  if (operation === "board_connection_status")
    return connectionStatus(input, { config, requestId, fetchImpl });
  if (operation === "board_scene_patch")
    return invokeScenePatch(input, { config, requestId, fetchImpl });
  const credential = await readCredential(config);
  if (credential === null) {
    throw new SceneBoardApiError(
      "BOARD_API_NOT_CONNECTED",
      config.credentialMode === "api_key"
        ? "SceneBoard API fallback has no configured API key"
        : "SceneBoard API fallback is not paired",
      {
        details: {
          recovery:
            config.credentialMode === "api_key" ? "set_api_key" : "run_pair",
        },
      },
    );
  }
  const spec = protectedSpec(operation, input, requestId);
  const envelope = await authorizedRequest(config, credential, {
    ...spec,
    requestId,
    allowedErrorCodes: OPERATION_ERROR_CODES[operation],
    expectedStatus: CREATED_SUCCESS_TYPES.has(spec.expectedType)
      ? [200, 201]
      : [200],
    timeoutMs:
      spec.minimumTimeoutMs === undefined
        ? undefined
        : Math.max(config.timeoutMs, spec.minimumTimeoutMs),
    fetchImpl,
  });
  return { requestId, result: envelope.result, metadata: envelope.metadata };
};

const connectionStatus = async (input, { config, requestId, fetchImpl }) => {
  assertExactInput(input, ["boardId"]);
  if (input.boardId !== null) globalId(input.boardId, "boardId");
  const credential = await readCredential(config);
  const safeConfig = {
    source: config.source,
    profile: config.profile,
    baseOrigin: config.baseUrl,
    timeoutMs: config.timeoutMs,
    hasToken: credential !== null,
    credentialMode: config.credentialMode,
  };
  if (credential === null)
    return {
      requestId,
      result: {
        state: "credential_missing",
        config: safeConfig,
        connection: null,
        lastErrorCode: null,
      },
      metadata: null,
    };
  const query = new URLSearchParams({ requestId });
  if (input.boardId !== null) {
    query.set("boardId", input.boardId);
    if (config.credentialMode === "api_key")
      query.set("authorizationOperation", "board.get");
  }
  try {
    const result = await requestJson({
      config,
      path: `/api/v1/mcp/connection?${query}`,
      authorization: `Bearer ${credential.accessToken}`,
      requestId,
      expectedStatus: [200],
      allowedErrorCodes: OPERATION_ERROR_CODES.board_connection_status,
      requirePairingHeaders: "connection",
      connectionBoardId: input.boardId,
      connectionCredentialMode: config.credentialMode,
      fetchImpl,
    });
    return {
      requestId,
      result: {
        state: "connected",
        config: safeConfig,
        connection: result,
        lastErrorCode: null,
      },
      metadata: null,
    };
  } catch (error) {
    if (
      error instanceof SceneBoardApiError &&
      error.code === "UNAUTHENTICATED"
    ) {
      let deleted = false;
      if (credential.credentialMode === "pairing") {
        try {
          deleted = await deleteCredentialIfGeneration(
            config,
            credential.generation,
          );
        } catch {
          // Credential cleanup is best-effort while reporting invalid state.
        }
      }
      let hasToken = !deleted;
      if (!deleted) {
        try {
          hasToken = (await readCredential(config)) !== null;
        } catch {
          hasToken = true;
        }
      }
      return {
        requestId,
        result: {
          state: "credential_invalid",
          config: { ...safeConfig, hasToken },
          connection: null,
          lastErrorCode: "UNAUTHENTICATED",
        },
        metadata: null,
      };
    }
    if (error instanceof SceneBoardApiError && error.retryable) {
      return {
        requestId,
        result: {
          state: "backend_unavailable",
          config: safeConfig,
          connection: null,
          lastErrorCode: error.code,
        },
        metadata: null,
      };
    }
    throw error;
  }
};

const invokeScenePatch = async (input, { config, requestId, fetchImpl }) => {
  assertExactInput(input, [
    "boardId",
    "expectedRevisionId",
    "idempotencyKey",
    "operations",
  ]);
  globalId(input.boardId, "boardId");
  globalId(input.expectedRevisionId, "expectedRevisionId");
  idempotencyKey(input.idempotencyKey);
  if (
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > 1_000
  )
    invalidInput("operations");
  const operationDeadline = performance.now() + config.timeoutMs;
  const credential = await readCredential(config);
  if (credential === null)
    throw new SceneBoardApiError(
      "BOARD_API_NOT_CONNECTED",
      config.credentialMode === "api_key"
        ? "SceneBoard API fallback has no configured API key"
        : "SceneBoard API fallback is not paired",
      {
        details: {
          recovery:
            config.credentialMode === "api_key" ? "set_api_key" : "run_pair",
        },
      },
    );
  // A scene patch is one public operation backed by two HTTP requests. Keep the
  // public request ID for the mutation/result, but give the prerequisite head
  // read its own correlation ID so strict servers never see an ID reused for a
  // different request.
  const headRequestId = randomBytes(16).toString("base64url");
  const head = await authorizedRequest(config, credential, {
    path: `/api/v1/boards/${input.boardId}?requestId=${headRequestId}`,
    requestId: headRequestId,
    expectedStatus: [200],
    expectedType: "board.get",
    allowedErrorCodes: OPERATION_ERROR_CODES.board_get,
    retryKind: "read",
    correlation: { boardId: input.boardId },
    operationDeadline,
    fetchImpl,
  });
  const snapshot = head.result?.result?.snapshot;
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.scene) ||
    !isRecord(snapshot.revision) ||
    typeof snapshot.revision.revisionId !== "string"
  ) {
    throw new SceneBoardApiError(
      "BOARD_API_RESPONSE_INVALID",
      "SceneBoard response is invalid",
      {
        details: { reason: "schema" },
      },
    );
  }
  if (snapshot.revision.revisionId !== input.expectedRevisionId) {
    throw new SceneBoardApiError(
      "REVISION_CONFLICT",
      "SceneBoard request failed: REVISION_CONFLICT",
      {
        details: {
          boardId: input.boardId,
          expectedRevisionId: input.expectedRevisionId,
          actualRevisionId: snapshot.revision.revisionId,
          actualRevisionNumber: snapshot.revision.revisionNumber,
          recovery: "fetch_latest_then_retry",
        },
      },
    );
  }
  const scene = applyScenePatch(snapshot.scene, input.operations);
  const spec = mutationSpec(
    baseMutation(input, requestId, { type: "scene.replace", scene }),
    "scene.replace",
  );
  const envelope = await authorizedRequest(config, credential, {
    ...spec,
    requestId,
    expectedStatus: [200, 201],
    allowedErrorCodes: OPERATION_ERROR_CODES.board_scene_patch,
    operationDeadline,
    fetchImpl,
  });
  return {
    requestId,
    result: envelope.result,
    metadata: {
      type: "scene-transform",
      transformedFromRevisionId: snapshot.revision.revisionId,
    },
  };
};

export const safeFailure = (error, operation = null) => {
  const failure =
    error instanceof SceneBoardApiError
      ? error
      : new SceneBoardApiError(
          "BOARD_API_INTERNAL_ERROR",
          "SceneBoard API fallback failed",
          {
            details: { incidentId: randomBytes(16).toString("base64url") },
          },
        );
  return {
    ok: false,
    transport: "api",
    operation,
    error: {
      code: failure.code,
      message:
        safeText(failure.message) && !containsSecretValue(failure.message)
          ? failure.message
          : "SceneBoard API fallback failed",
      retryable: failure.retryable,
      details: sanitizePublicValue(failure.details),
    },
  };
};

export const publicConfig = (config) => ({
  source: config.source,
  profile: config.profile,
  baseOrigin: config.baseUrl,
  timeoutMs: config.timeoutMs,
  credentialMode: config.credentialMode,
});
