import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  BOARD_LIMITS_V1,
  HitlRequestDefinitionParserV1,
  HitlResponseParserV1,
  type BoardId,
  type HitlRequestDefinitionV1,
  type HitlRequestId,
  type HitlResponseV1,
  type IdempotencyKey,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@leecat-board/board-schema';

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

const LocalFieldIdSchemaV1 = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const TimestampSchemaV1 = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);
const ContentSchemaV1 = z.string()
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value), 'lone surrogate is not allowed')
  .refine((value) => [...value].length <= BOARD_LIMITS_V1.maxMarkdownChars, 'HITL body is too long');
const ResponseTextSchemaV1 = z.string()
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value), 'lone surrogate is not allowed')
  .refine((value) => [...value].length <= BOARD_LIMITS_V1.maxHitlTextChars, 'HITL text is too long');

const HitlOptionSchemaV1 = z.object({
  id: LocalFieldIdSchemaV1,
  label: ShortTextSchemaV1,
  description: ShortTextSchemaV1.optional(),
}).strict();

const HitlFieldSchemaV1 = z.discriminatedUnion('type', [
  z.object({
    id: LocalFieldIdSchemaV1, type: z.literal('text'), label: ShortTextSchemaV1,
    required: z.boolean(), defaultValue: ResponseTextSchemaV1.nullable(),
    minLength: z.number().int().safe().min(0).max(BOARD_LIMITS_V1.maxHitlTextChars),
    maxLength: z.number().int().safe().min(1).max(BOARD_LIMITS_V1.maxHitlTextChars),
  }).strict(),
  z.object({
    id: LocalFieldIdSchemaV1, type: z.literal('number'), label: ShortTextSchemaV1,
    required: z.boolean(), defaultValue: z.number().finite().nullable(),
    min: z.number().finite().nullable(), max: z.number().finite().nullable(),
  }).strict(),
  z.object({
    id: LocalFieldIdSchemaV1, type: z.literal('boolean'), label: ShortTextSchemaV1,
    required: z.boolean(), defaultValue: z.boolean().nullable(),
  }).strict(),
  z.object({
    id: LocalFieldIdSchemaV1, type: z.literal('select'), label: ShortTextSchemaV1,
    required: z.boolean(), defaultValue: LocalFieldIdSchemaV1.nullable(),
    options: z.array(HitlOptionSchemaV1).min(1).max(BOARD_LIMITS_V1.maxHitlOptions),
  }).strict(),
]);

const HitlDefinitionSchemaV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('info'), title: ShortTextSchemaV1, body: ContentSchemaV1,
    acknowledgeLabel: ShortTextSchemaV1,
  }).strict(),
  z.object({
    kind: z.literal('choice'), title: ShortTextSchemaV1, body: ContentSchemaV1.optional(),
    multiple: z.boolean(), minSelections: z.number().int().safe().min(1).max(BOARD_LIMITS_V1.maxHitlOptions),
    maxSelections: z.number().int().safe().min(1).max(BOARD_LIMITS_V1.maxHitlOptions),
    options: z.array(HitlOptionSchemaV1).min(1).max(BOARD_LIMITS_V1.maxHitlOptions),
  }).strict(),
  z.object({
    kind: z.literal('form'), title: ShortTextSchemaV1, body: ContentSchemaV1.optional(),
    fields: z.array(HitlFieldSchemaV1).min(1).max(BOARD_LIMITS_V1.maxHitlFields),
    submitLabel: ShortTextSchemaV1,
  }).strict(),
  z.object({
    kind: z.literal('confirmation'), title: ShortTextSchemaV1, body: ContentSchemaV1,
    impact: z.enum(['standard', 'destructive']), confirmLabel: ShortTextSchemaV1,
    cancelLabel: ShortTextSchemaV1,
  }).strict(),
]);

const HitlResponseSchemaV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('info'), acknowledged: z.literal(true) }).strict(),
  z.object({
    kind: z.literal('choice'),
    selectedOptionIds: z.array(LocalFieldIdSchemaV1).min(1).max(BOARD_LIMITS_V1.maxHitlOptions),
  }).strict(),
  z.object({
    kind: z.literal('form'),
    values: z.record(LocalFieldIdSchemaV1, z.union([ResponseTextSchemaV1, z.number().finite(), z.boolean(), z.null()])),
  }).strict(),
  z.object({ kind: z.literal('confirmation'), confirmed: z.boolean() }).strict(),
]);

export const InteractionRequestInputSchemaV1 = z.object({
  boardId: GlobalIdSchemaV1,
  expectedRevisionId: GlobalIdSchemaV1,
  idempotencyKey: IdempotencyKeySchemaV1,
  hitlRequestId: GlobalIdSchemaV1,
  definition: HitlDefinitionSchemaV1,
}).strict();

export const InteractionStatusInputSchemaV1 = z.object({
  boardId: GlobalIdSchemaV1,
  hitlRequestId: GlobalIdSchemaV1,
  wait: z.object({
    afterStateUpdatedAt: TimestampSchemaV1,
    timeoutMs: z.number().int().safe().min(0).max(BOARD_LIMITS_V1.maxHitlWaitMs),
  }).strict().nullable(),
}).strict();

export const InteractionRespondInputSchemaV1 = z.object({
  boardId: GlobalIdSchemaV1,
  expectedRevisionId: GlobalIdSchemaV1,
  idempotencyKey: IdempotencyKeySchemaV1,
  hitlRequestId: GlobalIdSchemaV1,
  response: HitlResponseSchemaV1,
}).strict();

export class InteractionToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async request(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = InteractionRequestInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_interaction_request', requestId, parsed.error);
    const definition = HitlRequestDefinitionParserV1.parse(parsed.data.definition);
    if (!definition.ok) return toolFailureV1('board_interaction_request', requestId, 'board', definition.error as unknown as Record<string, unknown>);
    const result = await this.gateway.call((client) => client.mutateBoard({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      boardId: parsed.data.boardId as BoardId,
      expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
      idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
      command: {
        type: 'hitl.request',
        hitlRequestId: parsed.data.hitlRequestId as HitlRequestId,
        request: definition.data.value as HitlRequestDefinitionV1,
      },
    }, signal));
    return result.connected
      ? sdkToolResultV1('board_interaction_request', requestId, result.value, null)
      : toolFailureV1('board_interaction_request', requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>);
  }

  async status(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = InteractionStatusInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_interaction_status', requestId, parsed.error);
    const result = await this.gateway.call((client) => client.getInteraction({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      type: 'hitl.read',
      boardId: parsed.data.boardId as BoardId,
      hitlRequestId: parsed.data.hitlRequestId as HitlRequestId,
      wait: parsed.data.wait === null ? null : {
        afterStateUpdatedAt: parsed.data.wait.afterStateUpdatedAt as TimestampV1,
        timeoutMs: parsed.data.wait.timeoutMs,
      },
    }, signal));
    return result.connected
      ? sdkToolResultV1('board_interaction_status', requestId, result.value, null)
      : toolFailureV1('board_interaction_status', requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>);
  }

  async respond(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = InteractionRespondInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_interaction_respond', requestId, parsed.error);
    const response = HitlResponseParserV1.parse(parsed.data.response);
    if (!response.ok) return toolFailureV1('board_interaction_respond', requestId, 'board', response.error as unknown as Record<string, unknown>);
    const result = await this.gateway.call((client) => client.mutateBoard({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      boardId: parsed.data.boardId as BoardId,
      expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
      idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
      command: {
        type: 'hitl.respond',
        hitlRequestId: parsed.data.hitlRequestId as HitlRequestId,
        response: response.data.value as HitlResponseV1,
      },
    }, signal));
    return result.connected
      ? sdkToolResultV1('board_interaction_respond', requestId, result.value, null)
      : toolFailureV1('board_interaction_respond', requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>);
  }
}
