import { randomBytes } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  BoardDocumentParserV2,
  type BoardId,
  type IdempotencyKey,
  type ImageNodeV1,
  type NodeId,
  type PageId,
  type RequestId,
  type RevisionId,
} from '@sceneboard/board-schema';
import { placeMediaImageOnPageV1 } from '@sceneboard/board-sdk/document-transform';
import type { BoardSdkHttpLocalErrorV1 } from '@sceneboard/board-sdk/http';

import { captureLocalMediaFileV1 } from '../media/local-media-file.js';
import type { ConnectionHttpLocalErrorV1 } from '../connection/connection-http.client.js';
import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import { createRequestIdV1, GlobalIdSchemaV1, IdempotencyKeySchemaV1 } from './tool-schemas.js';
import {
  credentialUnavailableV1,
  inputInvalidV1,
  internalToolErrorV1,
  localFromSdkErrorV1,
  localMediaErrorV1,
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  toolSuccessV1,
  validationFailureV1,
  type BoardToolNameV1,
} from './tool-result.js';

const FitSchema = z.enum(['contain', 'cover', 'fill', 'none']);
const MediaTextSchema = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 1 && length <= 500 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
});
const MeaningfulImageSchema = z
  .object({
    nodeId: GlobalIdSchemaV1,
    mediaId: GlobalIdSchemaV1,
    decorative: z.literal(false),
    alt: MediaTextSchema,
    caption: MediaTextSchema.optional(),
    fit: FitSchema.optional(),
  })
  .strict();
const DecorativeImageSchema = z
  .object({
    nodeId: GlobalIdSchemaV1,
    mediaId: GlobalIdSchemaV1,
    decorative: z.literal(true),
    alt: z.literal(''),
    fit: FitSchema.optional(),
  })
  .strict();

export const MediaUploadInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    path: z.string(),
    idempotencyKey: IdempotencyKeySchemaV1,
  })
  .strict();

export const MediaPlaceInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    pageId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
    image: z.discriminatedUnion('decorative', [MeaningfulImageSchema, DecorativeImageSchema]),
    placement: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('page-end'), wrapperNodeId: GlobalIdSchemaV1 }).strict(),
      z
        .object({
          kind: z.literal('canvas'),
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
          zIndex: z.number().int().safe(),
        })
        .strict(),
    ]),
  })
  .strict();

const localConnectionError = (error: ConnectionHttpLocalErrorV1) =>
  localFromSdkErrorV1(
    (error.code === 'TRANSPORT_ERROR' && error.phase === 'connect'
      ? { ...error, phase: 'credential' }
      : error) as BoardSdkHttpLocalErrorV1,
  );

const authorizationFailure = (
  tool: BoardToolNameV1,
  requestId: string,
  result:
    | { authorized: false; reason: 'not_connected' | 'credential_unavailable' }
    | { authorized: false; reason: 'board'; error: Record<string, unknown> }
    | { authorized: false; reason: 'local'; error: ConnectionHttpLocalErrorV1 },
): CallToolResult => {
  if (result.reason === 'not_connected')
    return toolFailureV1(tool, requestId, 'mcp', notConnectedV1() as Record<string, unknown>);
  if (result.reason === 'credential_unavailable')
    return toolFailureV1(
      tool,
      requestId,
      'mcp',
      credentialUnavailableV1() as Record<string, unknown>,
    );
  if (result.reason === 'board') return toolFailureV1(tool, requestId, 'board', result.error);
  if (!('error' in result))
    return toolFailureV1(
      tool,
      requestId,
      'mcp',
      credentialUnavailableV1() as Record<string, unknown>,
    );
  return toolFailureV1(
    tool,
    requestId,
    'mcp',
    localConnectionError(result.error) as unknown as Record<string, unknown>,
  );
};

const internalFailure = (tool: BoardToolNameV1, requestId: string): CallToolResult =>
  toolFailureV1(
    tool,
    requestId,
    'mcp',
    internalToolErrorV1(randomBytes(16).toString('base64url')) as Record<string, unknown>,
  );

const boardFailure = (
  tool: BoardToolNameV1,
  requestId: string,
  value: Record<string, unknown>,
): CallToolResult => toolFailureV1(tool, requestId, 'board', value);

type UploadOutcome =
  | {
      kind: 'capture_error';
      code:
        | 'INPUT_INVALID'
        | 'LOCAL_FILE_CHANGED'
        | 'LOCAL_FILE_PLATFORM_UNSUPPORTED'
        | 'LOCAL_FILE_TOO_LARGE'
        | 'LOCAL_MEDIA_UNSUPPORTED';
    }
  | {
      kind: 'http';
      value: Awaited<
        ReturnType<
          import('../connection/connection-media-http.client.js').ConnectionMediaHttpClientV1['upload']
        >
      >;
    };

type PlacementOutcome =
  | {
      kind: 'sdk';
      value:
        | Awaited<
            ReturnType<
              import('@sceneboard/board-sdk/http').BoardSdkHttpClient['getDocumentHistory']
            >
          >
        | Awaited<
            ReturnType<import('@sceneboard/board-sdk/http').BoardSdkHttpClient['mutateDocument']>
          >;
    }
  | { kind: 'board'; error: Record<string, unknown> }
  | { kind: 'mismatch'; version: boolean };

export class MediaToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async upload(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    try {
      const parsed = MediaUploadInputSchemaV1.safeParse(raw);
      if (!parsed.success)
        return validationFailureV1('sceneboard_media_upload', requestId, parsed.error);
      const authorized = await this.gateway.withAuthorizedBoardOperation<UploadOutcome>(
        {
          boardId: parsed.data.boardId,
          requestId,
          requiredCapabilities: ['board.media.write'],
          ...(signal === undefined ? {} : { signal }),
        },
        async ({ snapshot, media, signal: operationSignal }) => {
          const captured = await captureLocalMediaFileV1(parsed.data.path);
          if (!captured.ok) return { kind: 'capture_error' as const, code: captured.code };
          try {
            return {
              kind: 'http' as const,
              value: await media.upload(
                {
                  boardId: parsed.data.boardId,
                  requestId,
                  idempotencyKey: parsed.data.idempotencyKey,
                  accessToken: snapshot.accessToken,
                  mime: captured.value.mime,
                  digestBase64: captured.value.digestBase64,
                  bytes: captured.value.bytes,
                },
                operationSignal,
              ),
            };
          } finally {
            captured.value.release();
          }
        },
      );
      if (!authorized.authorized)
        return authorizationFailure('sceneboard_media_upload', requestId, authorized as never);
      if (authorized.value.kind === 'capture_error') {
        if (authorized.value.code === 'INPUT_INVALID')
          return toolFailureV1(
            'sceneboard_media_upload',
            requestId,
            'mcp',
            inputInvalidV1(['path'], 'absolute local media path is invalid') as Record<
              string,
              unknown
            >,
          );
        return toolFailureV1(
          'sceneboard_media_upload',
          requestId,
          'mcp',
          localMediaErrorV1(authorized.value.code) as Record<string, unknown>,
        );
      }
      const result = authorized.value.value;
      if (result.ok)
        return toolSuccessV1('sceneboard_media_upload', requestId, result.result, null);
      if ('protocolVersion' in result.error)
        return boardFailure(
          'sceneboard_media_upload',
          requestId,
          result.error as unknown as Record<string, unknown>,
        );
      return toolFailureV1(
        'sceneboard_media_upload',
        requestId,
        'mcp',
        localFromSdkErrorV1(result.error as never) as unknown as Record<string, unknown>,
      );
    } catch {
      return internalFailure('sceneboard_media_upload', requestId);
    }
  }

  async place(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    try {
      const parsed = MediaPlaceInputSchemaV1.safeParse(raw);
      if (!parsed.success)
        return validationFailureV1('sceneboard_media_place', requestId, parsed.error);
      const authorized = await this.gateway.withAuthorizedBoardOperation<PlacementOutcome>(
        {
          boardId: parsed.data.boardId,
          requestId,
          requiredCapabilities: ['board.history.read', 'board.write'],
          ...(signal === undefined ? {} : { signal }),
        },
        async ({ client, signal: operationSignal }) => {
          const history = await client.getDocumentHistory(
            {
              protocolVersion: 1,
              requestId: requestId as RequestId,
              type: 'history.get',
              boardId: parsed.data.boardId as BoardId,
              revisionId: parsed.data.expectedRevisionId as RevisionId,
            },
            operationSignal,
          );
          if (!history.ok) return { kind: 'sdk' as const, value: history };
          const nested = history.result.result;
          if (nested.type !== 'history.get') throw new Error('history result invariant failed');
          if (
            nested.snapshot.revision.revisionId !== parsed.data.expectedRevisionId ||
            !('document' in nested.snapshot)
          )
            return {
              kind: 'mismatch' as const,
              version: !('document' in nested.snapshot),
            };
          const document = BoardDocumentParserV2.parse(nested.snapshot.document);
          if (!document.ok)
            return {
              kind: 'board' as const,
              error: document.error as unknown as Record<string, unknown>,
            };
          const source = parsed.data.image;
          const image: ImageNodeV1 = {
            id: source.nodeId as NodeId,
            type: 'content.image',
            source: { type: 'media', mediaId: source.mediaId as never },
            decorative: source.decorative as boolean,
            alt: source.alt,
            ...(source.decorative === false && source.caption !== undefined
              ? { caption: source.caption }
              : {}),
            fit: source.fit ?? 'contain',
          };
          const transformed = placeMediaImageOnPageV1({
            document: document.data.value,
            pageId: parsed.data.pageId as PageId,
            image,
            placement:
              parsed.data.placement.kind === 'page-end'
                ? {
                    kind: 'page-end',
                    wrapperNodeId: parsed.data.placement.wrapperNodeId as NodeId,
                  }
                : parsed.data.placement,
          });
          if (!transformed.ok)
            return {
              kind: 'board' as const,
              error: transformed.error as unknown as Record<string, unknown>,
            };
          return {
            kind: 'sdk' as const,
            value: await client.mutateDocument(
              {
                protocolVersion: 1,
                requestId: requestId as RequestId,
                boardId: parsed.data.boardId as BoardId,
                expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
                idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
                command: { type: 'document.replace', document: transformed.data.value },
              },
              operationSignal,
            ),
          };
        },
      );
      if (!authorized.authorized)
        return authorizationFailure('sceneboard_media_place', requestId, authorized as never);
      const outcome = authorized.value;
      if (outcome.kind === 'sdk')
        return sdkToolResultV1('sceneboard_media_place', requestId, outcome.value, null);
      if (outcome.kind === 'board')
        return boardFailure(
          'sceneboard_media_place',
          requestId,
          outcome.error as Record<string, unknown>,
        );
      return boardFailure('sceneboard_media_place', requestId, {
        protocolVersion: 1,
        type: 'board.error',
        code: 'DOCUMENT_VERSION_MISMATCH',
        message: 'Document version mismatch',
        category: 'conflict',
        retryable: false,
        httpStatusHint: 409,
        details: {
          headSchemaVersion: 1,
          commandSchemaVersion: 2,
          commandType: 'document.replace',
        },
      });
    } catch {
      return internalFailure('sceneboard_media_place', requestId);
    }
  }
}
