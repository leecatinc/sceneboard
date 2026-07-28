import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  BoardOperationResultParserV1,
  BoardOperationResultParserV2,
  MutationResultParserV1,
  MutationResultParserV2,
  MediaIngestResultParserV1,
} from '@sceneboard/board-schema';
import type {
  BoardSdkDocumentHttpResultV2,
  BoardSdkHttpResultV1,
} from '@sceneboard/board-sdk/http';

export type BoardToolNameV1 =
  | 'board_connection_status'
  | 'board_pair_request'
  | 'board_pair_status'
  | 'board_list'
  | 'board_get'
  | 'board_create'
  | 'board_archive'
  | 'board_capabilities_get'
  | 'board_scene_get'
  | 'board_scene_replace'
  | 'board_scene_patch'
  | 'board_scene_clear'
  | 'board_document_get'
  | 'board_document_replace'
  | 'board_page_add'
  | 'board_page_remove'
  | 'board_page_reorder'
  | 'board_page_update'
  | 'board_page_default_set'
  | 'board_history_list'
  | 'board_history_get'
  | 'board_history_restore'
  | 'board_artifact_get'
  | 'board_artifact_put'
  | 'board_artifact_stop'
  | 'board_interaction_request'
  | 'board_interaction_status'
  | 'board_interaction_respond'
  | 'sceneboard_media_upload'
  | 'sceneboard_media_place';

export type CoreToolNameV1 = Exclude<
  BoardToolNameV1,
  | 'board_artifact_get'
  | 'board_artifact_put'
  | 'board_artifact_stop'
  | 'board_interaction_request'
  | 'board_interaction_status'
  | 'board_interaction_respond'
>;

export type BoardMcpLocalErrorV1 =
  | {
      code: 'BOARD_MCP_INPUT_INVALID';
      message: string;
      retryable: false;
      details: { path: Array<string | number>; issue: string };
    }
  | { code: 'BOARD_MCP_NOT_CONNECTED'; message: string; retryable: false; details: null }
  | {
      code: 'BOARD_MCP_CREDENTIAL_UNAVAILABLE';
      message: string;
      retryable: false;
      details: unknown;
    }
  | { code: 'BOARD_MCP_PROFILE_BUSY'; message: string; retryable: true; details: unknown }
  | { code: 'BOARD_MCP_PROFILE_LEASE_CORRUPT'; message: string; retryable: false; details: unknown }
  | { code: 'BOARD_MCP_PAIRING_STATE_LOST'; message: string; retryable: false; details: unknown }
  | {
      code: 'BOARD_MCP_PAIRING_CLAIM_OUTCOME_UNKNOWN';
      message: string;
      retryable: false;
      details: unknown;
    }
  | {
      code: 'BOARD_MCP_PAIRING_CREDENTIAL_UNRECOVERABLE';
      message: string;
      retryable: false;
      details: unknown;
    }
  | { code: 'BOARD_MCP_TRANSPORT_ERROR'; message: string; retryable: true; details: unknown }
  | { code: 'BOARD_MCP_TIMEOUT'; message: string; retryable: true; details: { timeoutMs: number } }
  | { code: 'BOARD_MCP_CANCELLED'; message: string; retryable: false; details: null }
  | { code: 'BOARD_MCP_RESPONSE_INVALID'; message: string; retryable: false; details: unknown }
  | {
      code: 'BOARD_MCP_LOCAL_FILE_CHANGED';
      message: 'Local media file changed during capture';
      retryable: false;
      details: null;
    }
  | {
      code: 'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED';
      message: 'Secure local media capture is unavailable on this platform';
      retryable: false;
      details: null;
    }
  | {
      code: 'BOARD_MCP_LOCAL_FILE_TOO_LARGE';
      message: 'Local media file exceeds the upload limit';
      retryable: false;
      details: { limitBytes: 10_485_760 };
    }
  | {
      code: 'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED';
      message: 'Local media file format is unsupported';
      retryable: false;
      details: { allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] };
    }
  | {
      code: 'BOARD_MCP_INTERNAL_ERROR';
      message: string;
      retryable: false;
      details: { incidentId: string };
    };

const GlobalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const LOCAL_ERROR_CODES_V1 = [
  'BOARD_MCP_INPUT_INVALID',
  'BOARD_MCP_CONFIG_INVALID',
  'BOARD_MCP_CREDENTIAL_UNAVAILABLE',
  'BOARD_MCP_PROFILE_BUSY',
  'BOARD_MCP_PROFILE_LEASE_CORRUPT',
  'BOARD_MCP_NOT_CONNECTED',
  'BOARD_MCP_PAIRING_STATE_LOST',
  'BOARD_MCP_PAIRING_CLAIM_OUTCOME_UNKNOWN',
  'BOARD_MCP_PAIRING_CREDENTIAL_UNRECOVERABLE',
  'BOARD_MCP_TRANSPORT_ERROR',
  'BOARD_MCP_TIMEOUT',
  'BOARD_MCP_CANCELLED',
  'BOARD_MCP_RESPONSE_INVALID',
  'BOARD_MCP_LOCAL_FILE_CHANGED',
  'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED',
  'BOARD_MCP_LOCAL_FILE_TOO_LARGE',
  'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED',
  'BOARD_MCP_INTERNAL_ERROR',
] as const;
const GENERIC_LOCAL_ERROR_CODES_V1 = LOCAL_ERROR_CODES_V1.filter(
  (code) =>
    code !== 'BOARD_MCP_LOCAL_FILE_CHANGED' &&
    code !== 'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED' &&
    code !== 'BOARD_MCP_LOCAL_FILE_TOO_LARGE' &&
    code !== 'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED',
) as [
  Exclude<
    (typeof LOCAL_ERROR_CODES_V1)[number],
    | 'BOARD_MCP_LOCAL_FILE_CHANGED'
    | 'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED'
    | 'BOARD_MCP_LOCAL_FILE_TOO_LARGE'
    | 'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED'
  >,
  ...Array<
    Exclude<
      (typeof LOCAL_ERROR_CODES_V1)[number],
      | 'BOARD_MCP_LOCAL_FILE_CHANGED'
      | 'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED'
      | 'BOARD_MCP_LOCAL_FILE_TOO_LARGE'
      | 'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED'
    >
  >,
];

const D1_RESULT_TYPES_V1 = {
  board_list: ['board.list'],
  board_get: ['board.get'],
  board_create: ['board.create'],
  board_archive: ['board.archive'],
  board_capabilities_get: ['capabilities.get'],
  board_scene_get: ['board.get', 'history.get'],
  board_scene_replace: ['scene.replace'],
  board_scene_patch: ['scene.replace'],
  board_scene_clear: ['scene.clear'],
  board_document_get: ['board.get', 'history.get'],
  board_document_replace: ['document.replace'],
  board_page_add: ['document.replace'],
  board_page_remove: ['document.replace'],
  board_page_reorder: ['document.replace'],
  board_page_update: ['document.replace'],
  board_page_default_set: ['document.replace'],
  board_artifact_get: ['artifact.get'],
  board_artifact_put: ['artifact.publish'],
  board_artifact_stop: ['artifact.stop'],
  board_history_list: ['history.list'],
  board_history_get: ['history.get'],
  board_history_restore: ['scene.restore'],
  board_interaction_request: ['hitl.request'],
  board_interaction_status: ['hitl.read'],
  board_interaction_respond: ['hitl.respond'],
  sceneboard_media_upload: ['media.ingest.result'],
  sceneboard_media_place: ['document.replace'],
} as const satisfies Partial<Record<BoardToolNameV1, readonly string[]>>;

export const toolOutputSchemaV1 = (
  tool: BoardToolNameV1,
  reachableCodes: readonly [string, ...string[]],
): z.ZodTypeAny => {
  const upstreamCode = z.enum(reachableCodes);
  const value = (code: z.ZodTypeAny) => z.object({ code }).passthrough();
  const localValue = z.union([
    value(z.enum(GENERIC_LOCAL_ERROR_CODES_V1)),
    z
      .object({
        code: z.literal('BOARD_MCP_LOCAL_FILE_CHANGED'),
        message: z.literal('Local media file changed during capture'),
        retryable: z.literal(false),
        details: z.null(),
      })
      .strict(),
    z
      .object({
        code: z.literal('BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED'),
        message: z.literal('Secure local media capture is unavailable on this platform'),
        retryable: z.literal(false),
        details: z.null(),
      })
      .strict(),
    z
      .object({
        code: z.literal('BOARD_MCP_LOCAL_FILE_TOO_LARGE'),
        message: z.literal('Local media file exceeds the upload limit'),
        retryable: z.literal(false),
        details: z.object({ limitBytes: z.literal(10_485_760) }).strict(),
      })
      .strict(),
    z
      .object({
        code: z.literal('BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED'),
        message: z.literal('Local media file format is unsupported'),
        retryable: z.literal(false),
        details: z
          .object({
            allowedMimeTypes: z.tuple([
              z.literal('image/png'),
              z.literal('image/jpeg'),
              z.literal('image/webp'),
            ]),
          })
          .strict(),
      })
      .strict(),
  ]);
  const error = z.discriminatedUnion('source', [
    z.object({ source: z.literal('board'), value: value(upstreamCode) }).strict(),
    z.object({ source: z.literal('pairing'), value: value(upstreamCode) }).strict(),
    z.object({ source: z.literal('mcp'), value: localValue }).strict(),
  ]);
  const descriptor = z
    .object({
      ok: z.boolean(),
      tool: z.literal(tool),
      requestId: GlobalIdSchema,
      result: z.record(z.unknown()).optional(),
      metadata: z.unknown().optional(),
      error: error.optional(),
    })
    .strict();
  const validator = descriptor.superRefine((output, context) => {
    if (output.ok) {
      if (output.result === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result'],
          message: 'success result is required',
        });
        return;
      }
      if (output.error !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['error'],
          message: 'success cannot contain an error',
        });
      }
      if (!Object.hasOwn(output, 'metadata')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metadata'],
          message: 'success metadata is required',
        });
      }
      if (
        typeof output.result.requestId === 'string' &&
        output.result.requestId !== output.requestId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result', 'requestId'],
          message: 'request IDs must match',
        });
      }
      const expected = D1_RESULT_TYPES_V1[tool as keyof typeof D1_RESULT_TYPES_V1];
      if (expected !== undefined) {
        if (tool === 'sceneboard_media_upload') {
          const media = MediaIngestResultParserV1.parse(output.result);
          if (!media.ok) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['result'],
              message: 'result is not an exact media ingest result',
            });
          }
          if (output.metadata !== null) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['metadata'],
              message: 'media ingest metadata must be null',
            });
          }
          return;
        }
        const documentTool =
          tool === 'board_document_replace' ||
          tool === 'board_page_add' ||
          tool === 'board_page_remove' ||
          tool === 'board_page_reorder' ||
          tool === 'board_page_update' ||
          tool === 'board_page_default_set' ||
          tool === 'sceneboard_media_place';
        const documentReadTool = tool === 'board_document_get';
        const parsed =
          output.result.type === 'mutation.result'
            ? documentTool
              ? MutationResultParserV2.parse(output.result)
              : MutationResultParserV1.parse(output.result)
            : documentReadTool
              ? BoardOperationResultParserV2.parse(output.result)
              : BoardOperationResultParserV1.parse(output.result);
        if (!parsed.ok) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['result'],
            message: 'result is not an exact D1 envelope',
          });
        }
        const nested = output.result.result;
        if (
          nested === null ||
          typeof nested !== 'object' ||
          Array.isArray(nested) ||
          !expected.includes((nested as { type?: never }).type as never)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['result', 'result', 'type'],
            message: 'tool result type does not match',
          });
        }
        const nestedType = (nested as { type?: unknown } | null)?.type;
        const historyMetadata = nestedType === 'history.list' || nestedType === 'history.get';
        if (tool === 'board_scene_patch') {
          const metadata = output.metadata as {
            type?: unknown;
            transformedFromRevisionId?: unknown;
          } | null;
          if (
            metadata === null ||
            typeof metadata !== 'object' ||
            metadata.type !== 'scene-transform' ||
            typeof metadata.transformedFromRevisionId !== 'string' ||
            Object.keys(metadata).length !== 2
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['metadata'],
              message: 'scene patch metadata is invalid',
            });
          }
        } else if (historyMetadata) {
          const metadata = output.metadata as { type?: unknown; history?: unknown } | null;
          if (
            metadata === null ||
            typeof metadata !== 'object' ||
            metadata.type !== 'history' ||
            metadata.history === null ||
            typeof metadata.history !== 'object' ||
            Object.keys(metadata).length !== 2
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['metadata'],
              message: 'history metadata is invalid',
            });
          }
        } else if (output.metadata !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metadata'],
            message: 'non-history metadata must be null',
          });
        }
      }
      return;
    }
    if (output.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'failure error is required',
      });
    } else if (
      (tool === 'board_pair_request' || tool === 'board_pair_status') &&
      output.error.source === 'board'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error', 'source'],
        message: 'pairing tools cannot emit board errors',
      });
    } else if (
      tool !== 'board_pair_request' &&
      tool !== 'board_pair_status' &&
      output.error.source === 'pairing'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error', 'source'],
        message: 'non-pairing tools cannot emit pairing errors',
      });
    }
    if (output.result !== undefined || Object.hasOwn(output, 'metadata')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'failure cannot contain result metadata',
      });
    }
  });
  const schema = Object.create(descriptor) as typeof descriptor;
  Object.defineProperties(schema, {
    safeParse: { value: (input: unknown) => validator.safeParse(input) },
    safeParseAsync: { value: (input: unknown) => validator.safeParseAsync(input) },
    parse: { value: (input: unknown) => validator.parse(input) },
    parseAsync: { value: (input: unknown) => validator.parseAsync(input) },
  });
  return schema;
};

export const inputInvalidV1 = (
  path: Array<string | number>,
  issue: string,
): BoardMcpLocalErrorV1 => ({
  code: 'BOARD_MCP_INPUT_INVALID',
  message: 'Tool input is invalid',
  retryable: false,
  details: { path: path.slice(0, 32), issue: issue.slice(0, 200) },
});

export const notConnectedV1 = (): BoardMcpLocalErrorV1 => ({
  code: 'BOARD_MCP_NOT_CONNECTED',
  message: 'SceneBoard is not connected',
  retryable: false,
  details: null,
});

export const credentialUnavailableV1 = (): BoardMcpLocalErrorV1 => ({
  code: 'BOARD_MCP_CREDENTIAL_UNAVAILABLE',
  message: 'SceneBoard credential is unavailable',
  retryable: false,
  details: null,
});

export const localMediaErrorV1 = (
  code:
    | 'LOCAL_FILE_CHANGED'
    | 'LOCAL_FILE_PLATFORM_UNSUPPORTED'
    | 'LOCAL_FILE_TOO_LARGE'
    | 'LOCAL_MEDIA_UNSUPPORTED',
): BoardMcpLocalErrorV1 => {
  if (code === 'LOCAL_FILE_CHANGED')
    return {
      code: 'BOARD_MCP_LOCAL_FILE_CHANGED',
      message: 'Local media file changed during capture',
      retryable: false,
      details: null,
    };
  if (code === 'LOCAL_FILE_PLATFORM_UNSUPPORTED')
    return {
      code: 'BOARD_MCP_LOCAL_FILE_PLATFORM_UNSUPPORTED',
      message: 'Secure local media capture is unavailable on this platform',
      retryable: false,
      details: null,
    };
  if (code === 'LOCAL_FILE_TOO_LARGE')
    return {
      code: 'BOARD_MCP_LOCAL_FILE_TOO_LARGE',
      message: 'Local media file exceeds the upload limit',
      retryable: false,
      details: { limitBytes: 10_485_760 },
    };
  return {
    code: 'BOARD_MCP_LOCAL_MEDIA_UNSUPPORTED',
    message: 'Local media file format is unsupported',
    retryable: false,
    details: { allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] },
  };
};

export const internalToolErrorV1 = (incidentId: string): BoardMcpLocalErrorV1 => ({
  code: 'BOARD_MCP_INTERNAL_ERROR',
  message: 'SceneBoard tool execution failed',
  retryable: false,
  details: { incidentId },
});

export const localFromSdkErrorV1 = (
  error: Exclude<BoardSdkHttpResultV1<string>, { ok: true }>['error'],
): BoardMcpLocalErrorV1 => {
  if ('protocolVersion' in error)
    throw new TypeError('D1 errors must not be translated as local errors');
  if (error.code === 'CANCELLED')
    return {
      code: 'BOARD_MCP_CANCELLED',
      message: 'Tool call was cancelled',
      retryable: false,
      details: null,
    };
  if (error.code === 'TIMEOUT')
    return {
      code: 'BOARD_MCP_TIMEOUT',
      message: 'SceneBoard request timed out',
      retryable: true,
      details: { timeoutMs: error.timeoutMs },
    };
  if (error.code === 'TRANSPORT_ERROR')
    return {
      code: 'BOARD_MCP_TRANSPORT_ERROR',
      message: 'SceneBoard transport is unavailable',
      retryable: true,
      details: { phase: error.phase === 'credential' ? 'connect' : error.phase },
    };
  return {
    code: 'BOARD_MCP_RESPONSE_INVALID',
    message: 'SceneBoard response is invalid',
    retryable: false,
    details: { reason: error.reason },
  };
};

const asCallResult = (
  structuredContent: Record<string, unknown>,
  isError: boolean,
  text: string,
): CallToolResult => ({
  isError,
  content: [{ type: 'text', text }],
  structuredContent,
});

export const toolSuccessV1 = (
  tool: BoardToolNameV1,
  requestId: string,
  result: Record<string, unknown>,
  metadata: unknown,
): CallToolResult =>
  asCallResult(
    { ok: true, tool, requestId, result, metadata },
    false,
    `${tool} completed (${requestId})`,
  );

export const toolFailureV1 = (
  tool: BoardToolNameV1,
  requestId: string,
  source: 'board' | 'pairing' | 'mcp',
  value: Record<string, unknown>,
): CallToolResult =>
  asCallResult(
    { ok: false, tool, requestId, error: { source, value } },
    true,
    `${tool} failed: ${String(value.code ?? 'UNKNOWN')} (${requestId})`,
  );

export const sdkToolResultV1 = <K extends string>(
  tool: BoardToolNameV1,
  requestId: string,
  result: BoardSdkHttpResultV1<K> | BoardSdkDocumentHttpResultV2,
  metadata: unknown,
): CallToolResult => {
  if (result.ok)
    return toolSuccessV1(
      tool,
      requestId,
      result.result as unknown as Record<string, unknown>,
      metadata,
    );
  if ('protocolVersion' in result.error)
    return toolFailureV1(
      tool,
      requestId,
      'board',
      result.error as unknown as Record<string, unknown>,
    );
  return toolFailureV1(
    tool,
    requestId,
    'mcp',
    localFromSdkErrorV1(result.error) as unknown as Record<string, unknown>,
  );
};

export const validationFailureV1 = (
  tool: BoardToolNameV1,
  requestId: string,
  error: z.ZodError,
): CallToolResult => {
  const issue = error.issues[0];
  return toolFailureV1(
    tool,
    requestId,
    'mcp',
    inputInvalidV1(issue?.path ?? [], issue?.message ?? 'invalid input') as unknown as Record<
      string,
      unknown
    >,
  );
};
