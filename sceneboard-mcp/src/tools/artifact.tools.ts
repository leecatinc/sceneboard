import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  type ArtifactId,
  type ArtifactRequestCapabilityV1,
  type ArtifactVersionId,
  type BoardId,
  type IdempotencyKey,
  type RequestId,
  type RevisionId,
  type ShortText,
} from '@sceneboard/board-schema';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import {
  createRequestIdV1,
  GlobalIdSchemaV1,
  IdempotencyKeySchemaV1,
  ShortTextSchemaV1,
} from './tool-schemas.js';
import {
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  validationFailureV1,
} from './tool-result.js';

const SourceTextSchemaV1 = z
  .string()
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value), 'lone surrogate is not allowed');

const RequestedCapabilitiesSchemaV1 = z
  .array(z.enum(ARTIFACT_REQUEST_CAPABILITIES_V1))
  .max(ARTIFACT_REQUEST_CAPABILITIES_V1.length)
  .superRefine((capabilities, context) => {
    for (let index = 1; index < capabilities.length; index += 1) {
      if ((capabilities[index - 1] as string) >= (capabilities[index] as string)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'requested capabilities must be strictly sorted and unique',
        });
      }
    }
  });

export const ArtifactGetInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    artifactId: GlobalIdSchemaV1,
    versionId: GlobalIdSchemaV1,
  })
  .strict();

export const ArtifactPutInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
    artifactId: GlobalIdSchemaV1.nullable(),
    html: SourceTextSchemaV1,
    css: SourceTextSchemaV1.nullable(),
    javascript: SourceTextSchemaV1.nullable(),
    requestedCapabilities: RequestedCapabilitiesSchemaV1,
  })
  .strict();

export const ArtifactStopInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
    artifactId: GlobalIdSchemaV1,
    versionId: GlobalIdSchemaV1,
    reason: ShortTextSchemaV1,
  })
  .strict();

export class ArtifactToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = ArtifactGetInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_artifact_get', requestId, parsed.error);
    const result = await this.gateway.call(
      (client, _snapshot, operationSignal) =>
        client.getArtifact(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'artifact.get',
            boardId: parsed.data.boardId as BoardId,
            artifact: {
              artifactId: parsed.data.artifactId as ArtifactId,
              versionId: parsed.data.versionId as ArtifactVersionId,
            },
          },
          operationSignal,
        ),
      { signal },
    );
    return result.connected
      ? sdkToolResultV1('board_artifact_get', requestId, result.value, null)
      : toolFailureV1(
          'board_artifact_get',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async put(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = ArtifactPutInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_artifact_put', requestId, parsed.error);
    const result = await this.gateway.call(
      (client, _snapshot, operationSignal) =>
        client.putArtifact(
          requestId as RequestId,
          {
            boardId: parsed.data.boardId as BoardId,
            expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
            idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
            artifactId: parsed.data.artifactId as ArtifactId | null,
            html: parsed.data.html,
            css: parsed.data.css,
            javascript: parsed.data.javascript,
            requestedCapabilities: parsed.data
              .requestedCapabilities as ArtifactRequestCapabilityV1[],
          },
          operationSignal,
        ),
      { signal },
    );
    return result.connected
      ? sdkToolResultV1('board_artifact_put', requestId, result.value, null)
      : toolFailureV1(
          'board_artifact_put',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async stop(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = ArtifactStopInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_artifact_stop', requestId, parsed.error);
    const result = await this.gateway.call(
      (client, _snapshot, operationSignal) =>
        client.mutateBoard(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            boardId: parsed.data.boardId as BoardId,
            expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
            idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
            command: {
              type: 'artifact.stop',
              artifact: {
                artifactId: parsed.data.artifactId as ArtifactId,
                versionId: parsed.data.versionId as ArtifactVersionId,
              },
              reason: parsed.data.reason as ShortText,
            },
          },
          operationSignal,
        ),
      { signal },
    );
    return result.connected
      ? sdkToolResultV1('board_artifact_stop', requestId, result.value, null)
      : toolFailureV1(
          'board_artifact_stop',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }
}
