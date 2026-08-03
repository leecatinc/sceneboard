import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { LocalExportFileV1 } from '../exports/local-export-file.js';
import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import { createRequestIdV1, GlobalIdSchemaV1 } from './tool-schemas.js';
import {
  notConnectedV1,
  toolFailureV1,
  toolSuccessV1,
  validationFailureV1,
} from './tool-result.js';

export const BoardExportInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    revisionId: GlobalIdSchemaV1,
    format: z.enum(['pdf', 'pptx']),
    outputFile: z.string().min(1).max(4_096),
  })
  .strict();

const localTransportErrorV1 = (
  value:
    | { code: 'CANCELLED' }
    | { code: 'TIMEOUT'; timeoutMs: 120_000 }
    | { code: 'TRANSPORT_ERROR' }
    | { code: 'RESPONSE_INVALID' },
): Record<string, unknown> => {
  if (value.code === 'CANCELLED')
    return {
      code: 'BOARD_MCP_CANCELLED',
      message: 'Tool call was cancelled',
      retryable: false,
      details: null,
    };
  if (value.code === 'TIMEOUT')
    return {
      code: 'BOARD_MCP_TIMEOUT',
      message: 'SceneBoard request timed out',
      retryable: true,
      details: { timeoutMs: value.timeoutMs },
    };
  if (value.code === 'TRANSPORT_ERROR')
    return {
      code: 'BOARD_MCP_TRANSPORT_ERROR',
      message: 'SceneBoard transport is unavailable',
      retryable: true,
      details: { phase: 'response' },
    };
  return {
    code: 'BOARD_MCP_RESPONSE_INVALID',
    message: 'SceneBoard response is invalid',
    retryable: false,
    details: null,
  };
};

export class ExportToolHandlersV1 {
  constructor(
    private readonly gateway: ProtectedBoardGatewayV1,
    private readonly localFiles: LocalExportFileV1 | null,
  ) {}

  async export(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardExportInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_export', requestId, parsed.error);
    if (this.localFiles === null)
      return toolFailureV1('board_export', requestId, 'mcp', {
        code: 'LOCAL_EXPORT_UNAVAILABLE',
        message: 'Secure local export is unavailable on this platform',
        retryable: false,
        details: null,
      });
    const prepared = this.localFiles.preflight(parsed.data.outputFile, parsed.data.format);
    if (!prepared.ok)
      return toolFailureV1(
        'board_export',
        requestId,
        'mcp',
        prepared.error as unknown as Record<string, unknown>,
      );
    try {
      const remote = await this.gateway.exportBoard({
        boardId: parsed.data.boardId,
        revisionId: parsed.data.revisionId,
        format: parsed.data.format,
        publish: (artifact, operationSignal) =>
          this.localFiles!.publish(prepared.value, artifact, operationSignal),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!remote.connected)
        return toolFailureV1(
          'board_export',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
      if (!remote.value.ok) {
        if (remote.value.source === 'board')
          return toolFailureV1(
            'board_export',
            requestId,
            'board',
            remote.value.error as unknown as Record<string, unknown>,
          );
        if (remote.value.source === 'publication')
          return toolFailureV1(
            'board_export',
            requestId,
            'mcp',
            remote.value.error as unknown as Record<string, unknown>,
          );
        return toolFailureV1(
          'board_export',
          requestId,
          'mcp',
          localTransportErrorV1(remote.value.error),
        );
      }
      return toolSuccessV1(
        'board_export',
        requestId,
        remote.value.value as unknown as Record<string, unknown>,
        null,
      );
    } finally {
      this.localFiles.release(prepared.value);
    }
  }
}
