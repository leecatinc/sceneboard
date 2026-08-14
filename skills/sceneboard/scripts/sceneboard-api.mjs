import { randomBytes } from 'node:crypto';

import {
  SceneBoardApiError,
  acquirePairingLock,
  createPairingProof,
  deleteCredentialIfGeneration,
  getOrCreateInstallationId,
  invokeProtected,
  parseApiInputBytes,
  parsePairingClaim,
  parsePairingRedeem,
  parsePairingStatus,
  publicConfig,
  readCredential,
  requestJson,
  resolveApiConfig,
  safeFailure,
  validatePairingAuthorization,
  validatePairInput,
  writeCredential,
} from './sceneboard-api-core.mjs';

const OPERATIONS = [
  'board_connection_status',
  'board_list',
  'board_get',
  'board_create',
  'board_archive',
  'board_capabilities_get',
  'board_scene_get',
  'board_scene_replace',
  'board_scene_patch',
  'board_scene_clear',
  'board_artifact_get',
  'board_artifact_put',
  'board_artifact_stop',
  'board_history_list',
  'board_history_get',
  'board_history_restore',
  'board_interaction_request',
  'board_interaction_status',
  'board_interaction_respond',
];

const WINDOWS_CREDENTIAL_FAILURE_REASONS = new Set([
  'windows_system_root_unavailable',
  'windows_dpapi_process_unavailable',
  'windows_dpapi_timeout',
  'windows_dpapi_output_too_large',
  'windows_dpapi_failed',
  'windows_dpapi_empty_output',
  'windows_dpapi_input_failed',
]);

const pairingCredentialFailure = (phase, error) => {
  const reason =
    error instanceof SceneBoardApiError &&
    WINDOWS_CREDENTIAL_FAILURE_REASONS.has(error.details?.reason)
      ? error.details.reason
      : undefined;
  return new SceneBoardApiError(
    'BOARD_API_PAIRING_CREDENTIAL_UNRECOVERABLE',
    'SceneBoard paired credential could not be proven',
    {
      details: {
        phase,
        ...(reason === undefined ? {} : { reason }),
        recovery: 'owner_rotate_or_revoke_and_repair',
      },
    },
  );
};

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const readStdinJson = async () => {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 1_048_576) {
      throw new SceneBoardApiError(
        'INVALID_PAYLOAD',
        'SceneBoard API fallback input is too large',
        { exitCode: 2 },
      );
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0)
    throw new SceneBoardApiError(
      'INVALID_PAYLOAD',
      'SceneBoard API fallback requires JSON on stdin',
      { exitCode: 2 },
    );
  return parseApiInputBytes(bytes);
};

const pair = async () => {
  const input = validatePairInput(await readStdinJson());
  const config = await resolveApiConfig();
  if (config.credentialMode === 'api_key') {
    throw new SceneBoardApiError(
      'BOARD_API_CONFIG_INVALID',
      'SceneBoard pairing is unavailable in API-key mode',
      { details: { recovery: 'use_api_key_set_command' } },
    );
  }
  const release = await acquirePairingLock(config);
  const proof = createPairingProof();
  try {
    const installationId = await getOrCreateInstallationId(config);
    let claim;
    try {
      claim = parsePairingClaim(
        await requestJson({
          config,
          path: '/api/v1/pairings/claim',
          method: 'POST',
          body: {
            code: input.code,
            installationId,
            clientName: input.clientName,
            requestedScopes: input.requestedScopes,
            requestedLifecyclePermissions: input.requestedLifecyclePermissions,
            clientProofChallenge: proof.challenge,
          },
          expectedStatus: [202],
          requirePairingHeaders: 'claim',
        }),
      );
    } catch (error) {
      if (
        error instanceof SceneBoardApiError &&
        ['BOARD_API_TIMEOUT', 'BOARD_API_TRANSPORT_ERROR'].includes(error.code)
      ) {
        throw new SceneBoardApiError(
          'BOARD_API_PAIRING_OUTCOME_UNKNOWN',
          'SceneBoard pairing claim outcome is unknown',
          {
            details: {
              phase: 'claim',
              recovery: 'owner_cancel_or_wait_then_create_new_code',
            },
          },
        );
      }
      throw error;
    }
    write({
      ok: true,
      transport: 'api',
      operation: 'pair',
      event: 'claimed',
      pairingId: claim.pairingId,
      state: claim.state,
      decisionExpiresAt: claim.decisionExpiresAt,
    });
    let status = claim;
    const decisionDeadline = Date.parse(claim.decisionExpiresAt);
    let deadlinePollAttempted = false;
    while (status.state === 'pending') {
      const delaySeconds =
        status.retryAfterSeconds === undefined ? claim.pollAfterSeconds : status.retryAfterSeconds;
      const remaining = Math.max(0, decisionDeadline - Date.now());
      if (remaining === 0) {
        if (deadlinePollAttempted) {
          throw new SceneBoardApiError(
            'BOARD_API_TIMEOUT',
            'SceneBoard pairing status did not reach a terminal state',
            {
              retryable: true,
            },
          );
        }
        deadlinePollAttempted = true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delaySeconds * 1_000, remaining)),
      );
      status = parsePairingStatus(
        await requestJson({
          config,
          path: `/api/v1/pairings/${encodeURIComponent(claim.pairingId)}/client-status`,
          authorization: `PairingProof ${proof.value}`,
          expectedStatus: [200],
          requirePairingHeaders: 'status',
          retryKind: 'read',
        }),
        claim.pairingId,
      );
      write({
        ok: true,
        transport: 'api',
        operation: 'pair',
        event: 'status',
        pairingId: status.pairingId,
        state: status.state,
        decisionExpiresAt: status.decisionExpiresAt,
        redeemExpiresAt: status.redeemExpiresAt,
      });
    }
    if (status.state !== 'approved') {
      write({
        ok: true,
        transport: 'api',
        operation: 'pair',
        event: 'terminal',
        pairingId: status.pairingId,
        state: status.state,
        hasToken: false,
      });
      return;
    }
    const redeem = () =>
      requestJson({
        config,
        path: `/api/v1/pairings/${encodeURIComponent(claim.pairingId)}/redeem`,
        method: 'POST',
        body: {},
        authorization: `PairingProof ${proof.value}`,
        expectedStatus: [200],
        requirePairingHeaders: 'redeem',
      });
    let redeemed;
    const ambiguousTransport = (error) =>
      error instanceof SceneBoardApiError &&
      ['BOARD_API_TIMEOUT', 'BOARD_API_TRANSPORT_ERROR'].includes(error.code);
    const unknownRedeemOutcome = (state = null) =>
      new SceneBoardApiError(
        'BOARD_API_PAIRING_OUTCOME_UNKNOWN',
        'SceneBoard pairing redeem outcome is unknown',
        {
          details: {
            phase: 'redeem',
            state,
            recovery: 'owner_rotate_or_revoke_and_repair',
          },
        },
      );
    try {
      redeemed = await redeem();
    } catch (error) {
      if (ambiguousTransport(error)) {
        let resolved;
        try {
          resolved = parsePairingStatus(
            await requestJson({
              config,
              path: `/api/v1/pairings/${encodeURIComponent(claim.pairingId)}/client-status`,
              authorization: `PairingProof ${proof.value}`,
              expectedStatus: [200],
              requirePairingHeaders: 'status',
              retryKind: 'read',
            }),
            claim.pairingId,
          );
        } catch (resolutionError) {
          if (ambiguousTransport(resolutionError)) throw unknownRedeemOutcome();
          throw resolutionError;
        }
        if (resolved.state !== 'approved') throw unknownRedeemOutcome(resolved.state);
        try {
          redeemed = await redeem();
        } catch (retryError) {
          if (ambiguousTransport(retryError)) throw unknownRedeemOutcome(resolved.state);
          throw retryError;
        }
      } else {
        throw error;
      }
    }
    redeemed = parsePairingRedeem(redeemed);
    let storedGeneration = null;
    let credentialPhase = 'connection_request';
    try {
      const requestId = randomBytes(16).toString('base64url');
      const connection = await requestJson({
        config,
        path: `/api/v1/mcp/connection?requestId=${requestId}`,
        authorization: `Bearer ${redeemed.accessToken}`,
        requestId,
        expectedStatus: [200],
        allowedErrorCodes: [
          'INVALID_PAYLOAD',
          'UNAUTHENTICATED',
          'FORBIDDEN',
          'BOARD_NOT_FOUND',
          'RATE_LIMITED',
          'SERVICE_UNAVAILABLE',
          'INTERNAL_ERROR',
        ],
        requirePairingHeaders: 'connection',
        connectionBoardId: null,
      });
      credentialPhase = 'authorization_validation';
      validatePairingAuthorization(redeemed, connection, input);
      credentialPhase = 'credential_write';
      storedGeneration = await writeCredential(config, redeemed.accessToken);
      redeemed.accessToken = '';
      credentialPhase = 'credential_reload';
      const stored = await readCredential(config);
      if (stored === null || stored.generation !== storedGeneration) {
        credentialPhase = 'credential_reload_mismatch';
        throw new Error('credential reload mismatch');
      }
    } catch (error) {
      redeemed.accessToken = '';
      if (storedGeneration !== null) {
        try {
          await deleteCredentialIfGeneration(config, storedGeneration);
        } catch {
          // Credential cleanup must not replace the pairing failure.
        }
      }
      throw pairingCredentialFailure(credentialPhase, error);
    }
    write({
      ok: true,
      transport: 'api',
      operation: 'pair',
      event: 'redeemed',
      pairingId: claim.pairingId,
      state: 'redeemed',
      hasToken: true,
      config: publicConfig(config),
    });
  } finally {
    proof.bytes.fill(0);
    proof.value = '';
    proof.challenge = '';
    await release();
  }
};

const main = async () => {
  const [command, operation, ...extra] = process.argv.slice(2);
  if (command === 'describe' && operation === undefined) {
    const config = await resolveApiConfig();
    write({
      ok: true,
      transport: 'api',
      mode: 'mcp-absent-only',
      input: 'stdin-json',
      operations: OPERATIONS,
      pairingCommand: 'pair',
      config: publicConfig(config),
    });
    return;
  }
  if (command === 'pair' && operation === undefined) {
    await pair();
    return;
  }
  if (command !== 'invoke' || !OPERATIONS.includes(operation) || extra.length > 0) {
    throw new SceneBoardApiError(
      'INVALID_PAYLOAD',
      'Usage: describe | pair | invoke <board_operation>',
      { exitCode: 2 },
    );
  }
  const input = await readStdinJson();
  const result = await invokeProtected(operation, input);
  write({ ok: true, transport: 'api', operation, ...result });
};

try {
  await main();
} catch (error) {
  const candidate = process.argv[2] === 'invoke' ? process.argv[3] : process.argv[2];
  const operation =
    OPERATIONS.includes(candidate) || candidate === 'pair' || candidate === 'describe'
      ? candidate
      : null;
  write(safeFailure(error, operation));
  process.exitCode = error instanceof SceneBoardApiError ? error.exitCode : 1;
}
