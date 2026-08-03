import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';

import {
  DocumentGetInputSchemaV2,
  DocumentReplaceInputSchemaV2,
  DocumentToolHandlersV2,
  PageAddInputSchemaV2,
  PageDefaultSetInputSchemaV2,
  PageRemoveInputSchemaV2,
  PageReorderInputSchemaV2,
  PageUpdateInputSchemaV2,
} from './document.tools.js';
import {
  ArtifactGetInputSchemaV1,
  ArtifactPutInputSchemaV1,
  ArtifactStopInputSchemaV1,
  ArtifactToolHandlersV1,
} from './artifact.tools.js';
import {
  BoardToolHandlersV1,
  BoardArchiveInputSchemaV1,
  BoardCapabilitiesInputSchemaV1,
  BoardCreateInputSchemaV1,
  BoardGetInputSchemaV1,
  BoardListInputSchemaV1,
  BoardRenameInputSchemaV1,
} from './board.tools.js';
import {
  ConnectionStatusInputSchemaV1,
  ConnectionToolHandlersV1,
  PairRequestInputSchemaV1,
  PairStatusInputSchemaV1,
  type ConnectionStatusPortV1,
} from './connection.tools.js';
import {
  HistoryGetInputSchemaV1,
  HistoryListInputSchemaV1,
  HistoryRestoreInputSchemaV1,
  HistoryToolHandlersV1,
} from './history.tools.js';
import { BoardExportInputSchemaV1, ExportToolHandlersV1 } from './export.tools.js';
import {
  InteractionRequestInputSchemaV1,
  InteractionRespondInputSchemaV1,
  InteractionStatusInputSchemaV1,
  InteractionToolHandlersV1,
} from './interaction.tools.js';
import {
  MediaPlaceInputSchemaV1,
  MediaToolHandlersV1,
  MediaUploadInputSchemaV1,
} from './media.tools.js';
import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import {
  SceneClearInputSchemaV1,
  SceneGetInputSchemaV1,
  ScenePatchInputSchemaV1,
  SceneReplaceInputSchemaV1,
  SceneToolHandlersV1,
} from './scene.tools.js';
import { descriptorInputSchemaV1 } from './tool-schemas.js';
import {
  toolFailureV1,
  toolOutputSchemaV1,
  type BoardToolNameV1,
  type CoreToolNameV1,
} from './tool-result.js';
import type { PairingCoordinatorPortV1 } from '../pairing/pairing-session.owner.js';
import type { LocalExportFileV1 } from '../exports/local-export-file.js';

export const CORE_TOOL_NAMES_V1 = [
  'board_connection_status',
  'board_pair_request',
  'board_pair_status',
  'board_list',
  'board_get',
  'board_create',
  'board_archive',
  'board_capabilities_get',
  'board_scene_get',
  'board_scene_replace',
  'board_scene_patch',
  'board_scene_clear',
  'board_document_get',
  'board_document_replace',
  'board_page_add',
  'board_page_remove',
  'board_page_reorder',
  'board_page_update',
  'board_page_default_set',
  'sceneboard_media_upload',
  'sceneboard_media_place',
  'board_history_list',
  'board_history_get',
  'board_history_restore',
] as const satisfies readonly CoreToolNameV1[];

export const SAFE_TOOL_NAMES_V1 = CORE_TOOL_NAMES_V1.slice(0, 3);
export const PROTECTED_CORE_TOOL_NAMES_V1 = CORE_TOOL_NAMES_V1.slice(3);

export const DOWNSTREAM_TOOL_NAMES_V1 = [
  'board_artifact_get',
  'board_artifact_put',
  'board_artifact_stop',
  'board_interaction_request',
  'board_interaction_status',
  'board_interaction_respond',
] as const satisfies readonly Exclude<BoardToolNameV1, CoreToolNameV1>[];

export const BOARD_TOOL_NAMES_V1 = [
  ...CORE_TOOL_NAMES_V1.slice(0, 21),
  ...DOWNSTREAM_TOOL_NAMES_V1.slice(0, 3),
  ...CORE_TOOL_NAMES_V1.slice(21),
  ...DOWNSTREAM_TOOL_NAMES_V1.slice(3),
] as const satisfies readonly BoardToolNameV1[];

export const API_KEY_TOOL_NAMES_V1 = [
  'board_connection_status',
  'board_list',
  'board_get',
  'board_create',
  'board_rename',
  'board_archive',
  'board_capabilities_get',
  'board_scene_get',
  'board_scene_replace',
  'board_scene_patch',
  'board_scene_clear',
  'board_document_get',
  'board_document_replace',
  'board_page_add',
  'board_page_remove',
  'board_page_reorder',
  'board_page_update',
  'board_page_default_set',
  'board_history_list',
  'board_history_get',
  'board_history_restore',
  'board_export',
] as const satisfies readonly BoardToolNameV1[];

export const BOARD_TOOL_ERROR_CODES_V1 = {
  board_connection_status: [
    'INVALID_PAYLOAD',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_pair_request: [
    'INVALID_PAYLOAD',
    'PAIRING_UNAVAILABLE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
  ],
  board_pair_status: [
    'INVALID_PAYLOAD',
    'PAIRING_PROOF_INVALID',
    'PAIRING_NOT_READY',
    'PAIRING_TERMINAL',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
  ],
  board_list: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_create: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'IDEMPOTENCY_KEY_REUSED',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_rename: [
    'INVALID_PAYLOAD',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_archive: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'BOARD_ALREADY_ARCHIVED',
    'IDEMPOTENCY_KEY_REUSED',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_capabilities_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_scene_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'DOCUMENT_VERSION_MISMATCH',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_scene_replace: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_scene_patch: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_scene_clear: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_document_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'DOCUMENT_VERSION_MISMATCH',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_document_replace: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_page_add: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_page_remove: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_page_reorder: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_page_update: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_page_default_set: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  sceneboard_media_upload: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'INVALID_REQUEST',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_RESULT_EXPIRED',
    'PAYLOAD_TOO_LARGE',
    'INVALID_MEDIA_UPLOAD',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  sceneboard_media_place: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'DOCUMENT_VERSION_MISMATCH',
    'INVALID_DOCUMENT',
    'UNKNOWN_NODE_TYPE',
    'INVALID_LAYOUT',
    'DUPLICATE_NODE_ID',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_history_list: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_history_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_history_restore: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_export: [
    'EXPORT_INVALID_REQUEST',
    'EXPORT_UNAUTHENTICATED',
    'EXPORT_FORBIDDEN',
    'EXPORT_NOT_FOUND',
    'EXPORT_REQUIRED_CONTENT_UNSUPPORTED',
    'EXPORT_BOUNDS_EXCEEDED',
    'EXPORT_RATE_LIMITED',
    'EXPORT_RENDERER_UNAVAILABLE',
    'EXPORT_RENDER_TIMEOUT',
    'EXPORT_ENCODE_FAILED',
    'EXPORT_INTERNAL_ERROR',
  ],
  board_artifact_get: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'ARTIFACT_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_artifact_put: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'CAPABILITY_DENIED',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_artifact_stop: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'ARTIFACT_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_interaction_request: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'HITL_REQUEST_ID_CONFLICT',
    'LIMIT_EXCEEDED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_interaction_status: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'HITL_REQUEST_NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
  board_interaction_respond: [
    'INVALID_PAYLOAD',
    'PROTOCOL_VERSION_MISMATCH',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BOARD_NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'HITL_REQUEST_NOT_FOUND',
    'HITL_RESPONSE_CONFLICT',
    'HITL_REQUEST_EXPIRED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
    'INTERNAL_ERROR',
  ],
} as const satisfies Readonly<Record<BoardToolNameV1, readonly string[]>>;

export type CoreToolRegistryOptionsV1 = {
  gateway: ProtectedBoardGatewayV1;
  pairing: PairingCoordinatorPortV1;
  connections: ConnectionStatusPortV1;
  authenticated: boolean;
  downstreamReady?: boolean;
  credentialMode?: 'pairing' | 'api_key';
  localExports?: LocalExportFileV1;
};

export type CoreToolRegistryV1 = {
  names: readonly BoardToolNameV1[];
  setProtectedEnabled(enabled: boolean): void;
};

export const registerCoreToolsV1 = (
  server: McpServer,
  options: CoreToolRegistryOptionsV1,
): CoreToolRegistryV1 => {
  const registered = new Map<BoardToolNameV1, RegisteredTool>();
  const boards = new BoardToolHandlersV1(options.gateway);
  const scenes = new SceneToolHandlersV1(options.gateway);
  const documents = new DocumentToolHandlersV2(options.gateway);
  const history = new HistoryToolHandlersV1(options.gateway);
  const artifacts = new ArtifactToolHandlersV1(options.gateway);
  const interactions = new InteractionToolHandlersV1(options.gateway);
  const media = new MediaToolHandlersV1(options.gateway);
  const exports = new ExportToolHandlersV1(options.gateway, options.localExports ?? null);
  const credentialMode = options.credentialMode ?? 'pairing';
  const names =
    credentialMode === 'api_key'
      ? API_KEY_TOOL_NAMES_V1
      : options.downstreamReady === true
        ? BOARD_TOOL_NAMES_V1
        : CORE_TOOL_NAMES_V1;
  const protectedNames = names.filter(
    (name) => !SAFE_TOOL_NAMES_V1.includes(name as (typeof SAFE_TOOL_NAMES_V1)[number]),
  );
  let protectedEnabled = options.authenticated;
  const setProtectedEnabled = (enabled: boolean): void => {
    if (protectedEnabled === enabled) return;
    protectedEnabled = enabled;
    for (const name of protectedNames) {
      const tool = registered.get(name);
      if (enabled) tool?.enable();
      else tool?.disable();
    }
  };
  const connection = new ConnectionToolHandlersV1(
    options.connections,
    options.pairing,
    (connected) => setProtectedEnabled(connected),
  );
  const add = (
    name: BoardToolNameV1,
    description: string,
    inputSchema: Parameters<typeof descriptorInputSchemaV1>[0],
    handler: (raw: unknown, signal: AbortSignal) => Promise<CallToolResult>,
    protectedTool = false,
  ): void => {
    const tool = server.registerTool(
      name,
      {
        description,
        inputSchema: descriptorInputSchemaV1(inputSchema),
        outputSchema: toolOutputSchemaV1(name, BOARD_TOOL_ERROR_CODES_V1[name]),
      },
      async (raw, extra) => {
        let result;
        try {
          result = await handler(raw, extra.signal);
        } catch {
          result = toolFailureV1(name, randomBytes(16).toString('base64url'), 'mcp', {
            code: 'BOARD_MCP_INTERNAL_ERROR',
            message: 'SceneBoard tool execution failed',
            retryable: false,
            details: { incidentId: randomBytes(16).toString('base64url') },
          });
        }
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        const error = structured?.error as
          | { source?: unknown; value?: { code?: unknown } }
          | undefined;
        if (
          error?.source === 'board' &&
          (error.value?.code === 'UNAUTHENTICATED' ||
            error.value?.code === 'EXPORT_UNAUTHENTICATED')
        )
          setProtectedEnabled(false);
        return result;
      },
    );
    registered.set(name, tool);
    if (protectedTool && !protectedEnabled) tool.disable();
  };

  add(
    'board_connection_status',
    'Report redacted SceneBoard connection state for an explicit board ID or null.',
    ConnectionStatusInputSchemaV1,
    (raw, signal) => connection.status(raw, signal),
  );
  if (credentialMode === 'pairing') {
    add(
      'board_pair_request',
      'Claim a human-created pairing code using the configured private credential sink.',
      PairRequestInputSchemaV1,
      (raw, signal) => connection.pairRequest(raw, signal),
    );
    add(
      'board_pair_status',
      'Wait for or read the current proof-authenticated pairing state.',
      PairStatusInputSchemaV1,
      (raw, signal) => connection.pairStatus(raw, signal),
    );
  }
  add(
    'board_list',
    'List authorized SceneBoard boards.',
    BoardListInputSchemaV1,
    (raw, signal) => boards.list(raw, signal),
    true,
  );
  add(
    'board_get',
    'Read one current board summary and snapshot.',
    BoardGetInputSchemaV1,
    (raw, signal) => boards.get(raw, signal),
    true,
  );
  add(
    'board_create',
    'Create an empty board with caller-owned idempotency.',
    BoardCreateInputSchemaV1,
    (raw, signal) => boards.create(raw, signal),
    true,
  );
  if (credentialMode === 'api_key') {
    add(
      'board_rename',
      'Rename one owner board.',
      BoardRenameInputSchemaV1,
      (raw, signal) => boards.rename(raw, signal),
      true,
    );
  }
  add(
    'board_archive',
    'Archive one board with explicit confirmation.',
    BoardArchiveInputSchemaV1,
    (raw, signal) => boards.archive(raw, signal),
    true,
  );
  add(
    'board_capabilities_get',
    'Read current server-authorized capabilities for one board.',
    BoardCapabilitiesInputSchemaV1,
    (raw, signal) => boards.capabilities(raw, signal),
    true,
  );
  add(
    'board_scene_get',
    'Read a live or exact historical scene.',
    SceneGetInputSchemaV1,
    (raw, signal) => scenes.get(raw, signal),
    true,
  );
  add(
    'board_scene_replace',
    'Replace a scene at an explicitly observed head.',
    SceneReplaceInputSchemaV1,
    (raw, signal) => scenes.replace(raw, signal),
    true,
  );
  add(
    'board_scene_patch',
    'Apply the closed local transform catalog and submit one scene replacement.',
    ScenePatchInputSchemaV1,
    (raw, signal) => scenes.patch(raw, signal),
    true,
  );
  add(
    'board_scene_clear',
    'Clear a scene and create a restorable checkpoint.',
    SceneClearInputSchemaV1,
    (raw, signal) => scenes.clear(raw, signal),
    true,
  );
  add(
    'board_document_get',
    'Read one exact current or historical V2 document snapshot.',
    DocumentGetInputSchemaV2,
    (raw, signal) => documents.get(raw, signal),
    true,
  );
  add(
    'board_document_replace',
    'Replace one V2 document at an explicitly observed head.',
    DocumentReplaceInputSchemaV2,
    (raw, signal) => documents.replace(raw, signal),
    true,
  );
  add(
    'board_page_add',
    'Add one caller-identified page through a whole-document replacement.',
    PageAddInputSchemaV2,
    (raw, signal) => documents.add(raw, signal),
    true,
  );
  add(
    'board_page_remove',
    'Remove one explicit non-default page through a whole-document replacement.',
    PageRemoveInputSchemaV2,
    (raw, signal) => documents.remove(raw, signal),
    true,
  );
  add(
    'board_page_reorder',
    'Move one explicit page to a resulting-list index.',
    PageReorderInputSchemaV2,
    (raw, signal) => documents.reorder(raw, signal),
    true,
  );
  add(
    'board_page_update',
    'Update one page title, display mode, or scene through a whole-document replacement.',
    PageUpdateInputSchemaV2,
    (raw, signal) => documents.update(raw, signal),
    true,
  );
  add(
    'board_page_default_set',
    'Set the existing default page through a whole-document replacement.',
    PageDefaultSetInputSchemaV2,
    (raw, signal) => documents.defaultSet(raw, signal),
    true,
  );
  if (credentialMode === 'pairing') {
    add(
      'sceneboard_media_upload',
      'Upload one explicitly authorized local PNG, JPEG, or WebP file.',
      MediaUploadInputSchemaV1,
      (raw, signal) => media.upload(raw, signal),
      true,
    );
    add(
      'sceneboard_media_place',
      'Place one immutable media image in an exact V2 document revision.',
      MediaPlaceInputSchemaV1,
      (raw, signal) => media.place(raw, signal),
      true,
    );
  }
  if (credentialMode === 'pairing' && options.downstreamReady === true) {
    add(
      'board_artifact_get',
      'Read one exact immutable artifact/version manifest and runtime state.',
      ArtifactGetInputSchemaV1,
      (raw, signal) => artifacts.get(raw, signal),
      true,
    );
    add(
      'board_artifact_put',
      'Publish a bounded HTML/CSS/JavaScript source bundle as one immutable artifact version.',
      ArtifactPutInputSchemaV1,
      (raw, signal) => artifacts.put(raw, signal),
      true,
    );
    add(
      'board_artifact_stop',
      'Stop one exact artifact runtime without removing its scene placement.',
      ArtifactStopInputSchemaV1,
      (raw, signal) => artifacts.stop(raw, signal),
      true,
    );
  }

  add(
    'board_history_list',
    'List immutable board revisions newest first.',
    HistoryListInputSchemaV1,
    (raw, signal) => history.list(raw, signal),
    true,
  );
  add(
    'board_history_get',
    'Read one immutable revision and aligned navigation metadata.',
    HistoryGetInputSchemaV1,
    (raw, signal) => history.get(raw, signal),
    true,
  );
  add(
    'board_history_restore',
    'Copy-forward an immutable revision into a new head.',
    HistoryRestoreInputSchemaV1,
    (raw, signal) => history.restore(raw, signal),
    true,
  );
  if (credentialMode === 'api_key') {
    add(
      'board_export',
      'Export one explicit retained board revision to a new no-clobber local PDF or PPTX file.',
      BoardExportInputSchemaV1,
      (raw, signal) => exports.export(raw, signal),
      true,
    );
  }

  if (credentialMode === 'pairing' && options.downstreamReady === true) {
    add(
      'board_interaction_request',
      'Create an exact human interaction, then immediately await it with board_interaction_status.',
      InteractionRequestInputSchemaV1,
      (raw, signal) => interactions.request(raw, signal),
      true,
    );
    add(
      'board_interaction_status',
      'Read or bounded-wait for an interaction; bounded wait is the primary response delivery path.',
      InteractionStatusInputSchemaV1,
      (raw, signal) => interactions.status(raw, signal),
      true,
    );
    add(
      'board_interaction_respond',
      'Record one exact typed response with server-owned chronology and conflict checks.',
      InteractionRespondInputSchemaV1,
      (raw, signal) => interactions.respond(raw, signal),
      true,
    );
  }

  return { names, setProtectedEnabled };
};
