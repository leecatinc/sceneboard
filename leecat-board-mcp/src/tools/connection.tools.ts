import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PairingCoordinatorPortV1 } from '../pairing/pairing-session.owner.js';
import type { PairingCoordinatorLocalErrorV1 } from '../pairing/pairing-session.owner.js';
import { createRequestIdV1, GlobalIdSchemaV1, ShortTextSchemaV1 } from './tool-schemas.js';
import { inputInvalidV1, toolFailureV1, toolSuccessV1, validationFailureV1, type BoardMcpLocalErrorV1 } from './tool-result.js';

const ScopeSchema = z.enum(['board.read', 'board.write', 'board.history.read', 'board.hitl.request', 'board.hitl.respond', 'artifact.publish', 'artifact.control']);
const LifecycleSchema = z.enum(['board.create', 'board.archive']);

export const ConnectionStatusInputSchemaV1 = z.object({ boardId: GlobalIdSchemaV1.nullable() }).strict();
export const PairRequestInputSchemaV1 = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/i),
  clientName: ShortTextSchemaV1,
  requestedScopes: z.array(ScopeSchema).min(1).max(7),
  requestedLifecyclePermissions: z.array(LifecycleSchema).max(2),
}).strict();
export const PairStatusInputSchemaV1 = z.object({ pairingId: GlobalIdSchemaV1, waitTimeoutMs: z.number().int().safe().min(0).max(120_000) }).strict();

export type ConnectionStatusPortResultV1 =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; source: 'board' | 'mcp'; value: Record<string, unknown> };

export interface ConnectionStatusPortV1 {
  status(boardId: string | null, requestId: string, signal?: AbortSignal): Promise<ConnectionStatusPortResultV1>;
}

const pairLocalError = (error: PairingCoordinatorLocalErrorV1): BoardMcpLocalErrorV1 => {
  if (error.code === 'PAIRING_SINK_READ_ONLY' || error.code === 'PAIRING_SINK_UNAVAILABLE') return {
    code: 'BOARD_MCP_CREDENTIAL_UNAVAILABLE',
    message: 'Pairing credential storage is unavailable',
    retryable: false,
    details: {
      reason: error.code === 'PAIRING_SINK_READ_ONLY' ? 'pairing_sink_read_only' : 'pairing_sink_unavailable',
      recovery: 'select_writable_store_or_provision_token_out_of_band',
    },
  };
  if (error.code === 'PROFILE_BUSY') return {
    code: 'BOARD_MCP_PROFILE_BUSY',
    message: 'The SceneBoard profile is busy',
    retryable: true,
    details: error.reason === 'active_owner'
      ? { reason: 'active_owner', recovery: 'close_other_client_or_retry' }
      : { reason: 'liveness_unknown', recovery: 'check_host_then_retry' },
  };
  if (error.code === 'PROFILE_LEASE_CORRUPT') return { code: 'BOARD_MCP_PROFILE_LEASE_CORRUPT', message: 'The profile lease is invalid', retryable: false, details: { recovery: 'repair_profile_lease_out_of_band' } };
  if (error.code === 'PAIRING_STATE_LOST') return { code: 'BOARD_MCP_PAIRING_STATE_LOST', message: 'The pairing session is unavailable', retryable: false, details: { recovery: 'start_new_pairing' } };
  if (error.code === 'PAIRING_CLAIM_OUTCOME_UNKNOWN') return { code: 'BOARD_MCP_PAIRING_CLAIM_OUTCOME_UNKNOWN', message: 'The pairing claim outcome is unknown', retryable: false, details: { recovery: 'owner_cancel_or_wait_then_create_new_code' } };
  if (error.code === 'PAIRING_CREDENTIAL_UNRECOVERABLE') return { code: 'BOARD_MCP_PAIRING_CREDENTIAL_UNRECOVERABLE', message: 'The redeemed credential cannot be recovered', retryable: false, details: { recovery: 'owner_rotate_or_revoke_and_repair' } };
  if (error.code === 'TIMEOUT') return { code: 'BOARD_MCP_TIMEOUT', message: 'Pairing timed out', retryable: true, details: { timeoutMs: error.timeoutMs } };
  if (error.code === 'CANCELLED') return { code: 'BOARD_MCP_CANCELLED', message: 'Pairing was cancelled', retryable: false, details: null };
  if (error.code === 'RESPONSE_INVALID') return { code: 'BOARD_MCP_RESPONSE_INVALID', message: 'Pairing response is invalid', retryable: false, details: { reason: error.reason } };
  return { code: 'BOARD_MCP_TRANSPORT_ERROR', message: 'Pairing transport is unavailable', retryable: true, details: { phase: error.code === 'TRANSPORT_OUTCOME_UNKNOWN' ? error.phase : 'request' } };
};

export class ConnectionToolHandlersV1 {
  constructor(
    private readonly connections: ConnectionStatusPortV1,
    private readonly pairing: PairingCoordinatorPortV1,
    private readonly onConnectionState: (connected: boolean) => void,
  ) {}

  async status(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = ConnectionStatusInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_connection_status', requestId, parsed.error);
    const result = await this.connections.status(parsed.data.boardId, requestId, signal);
    if (!result.ok) return toolFailureV1('board_connection_status', requestId, result.source, result.value);
    if (result.value.state === 'connected') this.onConnectionState(true);
    else if (result.value.state === 'not_configured' || result.value.state === 'credential_missing'
      || result.value.state === 'credential_invalid') this.onConnectionState(false);
    return toolSuccessV1('board_connection_status', requestId, result.value, null);
  }

  async pairRequest(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = PairRequestInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_pair_request', requestId, parsed.error);
    const result = await this.pairing.request({
      code: parsed.data.code.toUpperCase(),
      clientName: parsed.data.clientName,
      requestedScopes: parsed.data.requestedScopes,
      requestedLifecyclePermissions: parsed.data.requestedLifecyclePermissions,
    }, signal);
    if (result.ok) return toolSuccessV1('board_pair_request', requestId, result.value as unknown as Record<string, unknown>, null);
    return result.source === 'pairing'
      ? toolFailureV1('board_pair_request', requestId, 'pairing', result.error as unknown as Record<string, unknown>)
      : toolFailureV1('board_pair_request', requestId, 'mcp', pairLocalError(result.error) as unknown as Record<string, unknown>);
  }

  async pairStatus(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = PairStatusInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_pair_status', requestId, parsed.error);
    const result = await this.pairing.status(parsed.data.pairingId, parsed.data.waitTimeoutMs, signal);
    if (result.ok) {
      if (result.value.state === 'redeemed') this.onConnectionState(true);
      return toolSuccessV1('board_pair_status', requestId, result.value as unknown as Record<string, unknown>, null);
    }
    return result.source === 'pairing'
      ? toolFailureV1('board_pair_status', requestId, 'pairing', result.error as unknown as Record<string, unknown>)
      : toolFailureV1('board_pair_status', requestId, 'mcp', pairLocalError(result.error) as unknown as Record<string, unknown>);
  }
}
