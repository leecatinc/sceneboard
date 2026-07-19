import { z } from 'zod';

import { ActorContextSchemaV1, isSortedUniqueScopesV1, type ActorContextV1 } from './actors.js';
import { ArtifactManifestSchemaV1, ArtifactReferenceSchemaV1, ArtifactResourceSchemaV1, ArtifactRuntimeSummarySchemaV1 } from './artifacts.js';
import { BoardCapabilitiesSchemaV1 } from './capabilities.js';
import { CLIENT_GRANT_CAPABILITIES_V1, NODE_TYPES_V1 } from './catalogs.js';
import { MutationEnvelopeSchemaV1, MutationRequestSchemaV1, MutationResultSchemaV1, type MutationEnvelopeV1, type MutationFingerprintInputV1 } from './commands.js';
import { BoardEventEnvelopeSchemaV1 } from './events.js';
import type { BoardErrorV1 } from './errors.js';
import { BoardErrorSchemaV1 } from './errors.js';
import {
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  GrantIdSchemaV1,
  PrincipalIdSchemaV1,
  ShortTextSchemaV1,
} from './identifiers.js';
import { HitlInteractionSchemaV1, HitlRequestDefinitionSchemaV1, HitlResponseSchemaV1 } from './hitl.js';
import type { JsonValue } from './json.js';
import { scalarLengthV1 } from './json.js';
import { BOARD_LIMITS_V1, MAX_HITL_RESPONSE_BYTES, MAX_SCENE_BYTES, type BoardLimitKeyV1 } from './limits.js';
import { BoardOperationEnvelopeSchemaV1, BoardOperationRequestSchemaV1, BoardOperationResultSchemaV1, type BoardLifecycleIdempotencyEnvelopeV1, type BoardOperationFingerprintInputV1 } from './operations.js';
import { applySchemaV1, runBytesKernelV1, runDecodedKernelV1, type KernelIssueV1, type KernelResultV1 } from './parser-kernel.js';
import { BoardNodeSchemaV1, SceneSchemaV1 } from './scene.js';
import { BoardSnapshotSchemaV1 } from './snapshots.js';

export type CanonicalContractValueV1<T> = { value: T; canonicalBytes: Uint8Array };
export type BoardParseResultV1<T> =
  | { ok: true; data: CanonicalContractValueV1<T> }
  | { ok: false; error: BoardErrorV1 };
export type BoardContractParserV1<T> = {
  parse(input: unknown): BoardParseResultV1<T>;
  parseBytes(bytes: Uint8Array): BoardParseResultV1<T>;
};

type ParserKind = 'generic' | 'scene' | 'node' | 'mutation' | 'operation' | 'event' | 'hitl-response';

const invalidPayload = (path: Array<string | number>, issue: string): BoardErrorV1 => ({ protocolVersion: 1, type: 'board.error', code: 'INVALID_PAYLOAD', message: 'Invalid payload', category: 'validation', retryable: false, httpStatusHint: 400, details: { path, issue: issue.slice(0, 200) || 'invalid payload' } });
const protocolMismatch = (receivedMajor: number | null): BoardErrorV1 => ({ protocolVersion: 1, type: 'board.error', code: 'PROTOCOL_VERSION_MISMATCH', message: 'Protocol version mismatch', category: 'protocol', retryable: false, httpStatusHint: 409, details: { reason: 'major', supportedMajor: 1, receivedMajor, field: 'protocolVersion' } });
const payloadTooLarge = (scope: 'envelope' | 'scene' | 'hitl.response' | 'artifact.resource' | 'artifact.total', actualBytes: number, maximumBytes: number): BoardErrorV1 => ({ protocolVersion: 1, type: 'board.error', code: 'PAYLOAD_TOO_LARGE', message: 'Payload is too large', category: 'validation', retryable: false, httpStatusHint: 413, details: { scope, actualBytes, maximumBytes } });
const limitExceeded = (limit: BoardLimitKeyV1, actual: number, path: Array<string | number>): BoardErrorV1 => ({ protocolVersion: 1, type: 'board.error', code: 'LIMIT_EXCEEDED', message: 'Contract limit exceeded', category: 'validation', retryable: false, httpStatusHint: 422, details: { limit, actual, maximum: BOARD_LIMITS_V1[limit], path } });
const invalidLayout = (path: Array<string | number>, reason: 'bounds' | 'overlap' | 'reference' | 'geometry'): BoardErrorV1 => ({ protocolVersion: 1, type: 'board.error', code: 'INVALID_LAYOUT', message: 'Layout correlation is invalid', category: 'validation', retryable: false, httpStatusHint: 422, details: { path, reason } });

const kernelError = (issue: KernelIssueV1): BoardErrorV1 => {
  if (issue.kind === 'payload_too_large') return payloadTooLarge('envelope', issue.actual ?? 0, issue.maximum ?? BOARD_LIMITS_V1.maxEnvelopeBytes);
  if (issue.kind === 'json_depth') return limitExceeded('maxJsonDepth', issue.actual ?? BOARD_LIMITS_V1.maxJsonDepth + 1, issue.path);
  if (issue.kind === 'json_container_entries') return limitExceeded('maxJsonContainerEntries', issue.actual ?? BOARD_LIMITS_V1.maxJsonContainerEntries + 1, issue.path);
  return invalidPayload(issue.path, issue.message);
};

const valueAtPath = (input: unknown, path: Array<string | number>): unknown => path.reduce<unknown>((value, key) => value !== null && typeof value === 'object' ? (value as Record<string | number, unknown>)[key] : undefined, input);
const actualSize = (value: unknown): number => Array.isArray(value) ? value.length : typeof value === 'string' ? scalarLengthV1(value) : value !== null && typeof value === 'object' ? Object.keys(value).length : typeof value === 'number' ? value : 0;
const actualForLimit = (input: unknown, path: Array<string | number>, limit: BoardLimitKeyV1): number => {
  const value = valueAtPath(input, path);
  if (limit === 'maxArtifactTotalBytes' && Array.isArray(value)) {
    return value.reduce<number>((total, resource) => total + (isRecord(resource) && typeof resource.byteLength === 'number' ? resource.byteLength : 0), 0);
  }
  if (limit === 'maxTableCells') {
    const table = valueAtPath(input, path.slice(0, -1));
    if (isRecord(table) && Array.isArray(table.columns) && Array.isArray(table.rows)) return table.columns.length * table.rows.length;
  }
  if (limit === 'maxChartPoints' && Array.isArray(value)) {
    return value.reduce<number>((total, series) => total + (isRecord(series) && Array.isArray(series.points) ? series.points.length : 0), 0);
  }
  return actualSize(value);
};

const inferLimitKey = (input: unknown, path: Array<string | number>, message: string): BoardLimitKeyV1 | null => {
  if (!/at most|less than or equal|too_big/i.test(message)) return null;
  const field = path.at(-1);
  const parent = valueAtPath(input, path.slice(0, -1));
  const parentType = isRecord(parent) && typeof parent.type === 'string' ? parent.type : null;
  if (field === 'children') {
    if (parentType === 'layout.split') return 'maxSplitChildren';
    if (parentType === 'layout.grid') return 'maxGridItems';
    if (parentType === 'layout.canvas') return 'maxCanvasItems';
  }
  if (field === 'tabs') return 'maxTabs';
  if (field === 'columns') return parentType === 'layout.grid' ? 'maxGridColumns' : 'maxTableColumns';
  if (field === 'rows') return parentType === 'layout.grid' ? 'maxGridRows' : 'maxTableRows';
  if (field === 'width' || field === 'height' || field === 'gap') return 'maxCanvasExtent';
  if (field === 'options' || field === 'selectedOptionIds') return 'maxHitlOptions';
  if (field === 'fields' || field === 'values') return 'maxHitlFields';
  if (field === 'minLength' || field === 'maxLength') return 'maxHitlTextChars';
  if (field === 'resources') return 'maxArtifactResources';
  if (field === 'series') return 'maxChartSeries';
  if (field === 'features') return 'maxMapFeatures';
  if (field === 'elements') return 'maxDrawingElements';
  if (field === 'byteLength') return 'maxArtifactResourceBytes';
  if (field === 'limit' || field === 'boards' || field === 'entries') return 'maxPageSize';
  if (field === 'cursor') return 'maxPageCursorChars';
  if (field === 'timeoutMs') return 'maxHitlWaitMs';
  return null;
};

const mapSchemaIssue = (input: unknown, issue: KernelIssueV1, kind: ParserKind): BoardErrorV1 => {
  const limitMatch = /^\[LIMIT:([^\]]+)\]/.exec(issue.message);
  if (limitMatch) {
    const key = limitMatch[1] as BoardLimitKeyV1;
    if (Object.hasOwn(BOARD_LIMITS_V1, key)) return limitExceeded(key, actualForLimit(input, issue.path, key), issue.path);
  }
  const inferredLimit = inferLimitKey(input, issue.path, issue.message);
  if (inferredLimit) return limitExceeded(inferredLimit, actualSize(valueAtPath(input, issue.path)), issue.path);
  if (issue.message.startsWith('[DUPLICATE_NODE_ID:')) {
    const match = /^\[DUPLICATE_NODE_ID:([^:]+):(.*)\]/.exec(issue.message);
    const duplicatePath = issue.path;
    let firstPath: Array<string | number> = [];
    try { firstPath = JSON.parse(match?.[2] ?? '[]') as Array<string | number>; } catch { firstPath = []; }
    return { protocolVersion: 1, type: 'board.error', code: 'DUPLICATE_NODE_ID', message: 'Duplicate node ID', category: 'validation', retryable: false, httpStatusHint: 422, details: { nodeId: (match?.[1] ?? 'node') as never, firstPath, duplicatePath } };
  }
  if (issue.message.startsWith('[INVALID_LAYOUT')) {
    const reason = issue.message.includes(':reference') || issue.message.includes('reference') || issue.message.includes('correlate') || issue.message.includes('missing') ? 'reference' : issue.message.includes('overlap') ? 'overlap' : issue.message.includes('geometry') || issue.message.includes('polygon') ? 'geometry' : 'bounds';
    return invalidLayout(issue.path, reason);
  }
  if (issue.message.includes('Invalid discriminator value')) {
    const received = valueAtPath(input, issue.path);
    if (kind === 'node' || issue.path.at(-1) === 'type' && issue.path.some((part) => part === 'root' || part === 'node')) return { protocolVersion: 1, type: 'board.error', code: 'UNKNOWN_NODE_TYPE', message: 'Unknown node type', category: 'validation', retryable: false, httpStatusHint: 422, details: { path: issue.path, receivedType: String(received ?? '') } };
    if (kind === 'mutation') return { protocolVersion: 1, type: 'board.error', code: 'UNKNOWN_COMMAND_TYPE', message: 'Unknown command type', category: 'validation', retryable: false, httpStatusHint: 422, details: { path: issue.path, receivedType: String(received ?? '') } };
    if (kind === 'operation') return { protocolVersion: 1, type: 'board.error', code: 'UNKNOWN_OPERATION_TYPE', message: 'Unknown operation type', category: 'validation', retryable: false, httpStatusHint: 422, details: { path: issue.path, receivedType: String(received ?? '') } };
  }
  return invalidPayload(issue.path, issue.message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const findSceneValues = (input: unknown): Array<{ value: Record<string, unknown>; path: Array<string | number> }> => {
  const scenes: Array<{ value: Record<string, unknown>; path: Array<string | number> }> = [];
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [{ value: input, path: [] }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (isRecord(current.value) && current.value.type === 'scene' && Object.hasOwn(current.value, 'root')) scenes.push({ value: current.value, path: current.path });
    if (Array.isArray(current.value)) current.value.forEach((value, index) => stack.push({ value, path: [...current.path, index] }));
    else if (isRecord(current.value)) Object.entries(current.value).forEach(([key, value]) => stack.push({ value, path: [...current.path, key] }));
  }
  return scenes;
};

const guardSceneLimits = (input: unknown, kind: ParserKind): BoardErrorV1 | null => {
  const scenes = findSceneValues(input);
  if (kind === 'scene' && scenes.length === 0 && isRecord(input)) scenes.push({ value: input, path: [] });
  for (const scene of scenes) {
    const canonical = runDecodedKernelV1(scene.value);
    if (canonical.ok && canonical.canonicalBytes.byteLength > MAX_SCENE_BYTES) return payloadTooLarge('scene', canonical.canonicalBytes.byteLength, MAX_SCENE_BYTES);
    const root = scene.value.root;
    if (root === null || !isRecord(root)) continue;
    let count = 0;
    const stack: Array<{ node: Record<string, unknown>; path: Array<string | number>; depth: number }> = [{ node: root, path: [...scene.path, 'root'], depth: 1 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      count += 1;
      if (current.depth > BOARD_LIMITS_V1.maxSceneDepth) return limitExceeded('maxSceneDepth', current.depth, current.path);
      const type = current.node.type;
      if (type === 'content.table' && Array.isArray(current.node.rows) && current.node.rows.length > BOARD_LIMITS_V1.maxTableRows) return limitExceeded('maxTableRows', current.node.rows.length, [...current.path, 'rows']);
      if (type === 'content.chart' && Array.isArray(current.node.series)) {
        const points = current.node.series.reduce<number>((total, series) => total + (isRecord(series) && Array.isArray(series.points) ? series.points.length : 0), 0);
        if (points > BOARD_LIMITS_V1.maxChartPoints) return limitExceeded('maxChartPoints', points, [...current.path, 'series']);
      }
      const children = type === 'layout.tabs' ? current.node.tabs : current.node.children;
      if (Array.isArray(children)) children.forEach((item, index) => {
        if (isRecord(item) && isRecord(item.node)) stack.push({ node: item.node, path: [...current.path, type === 'layout.tabs' ? 'tabs' : 'children', index, 'node'], depth: current.depth + 1 });
      });
    }
    if (count > BOARD_LIMITS_V1.maxSceneNodes) return limitExceeded('maxSceneNodes', count, [...scene.path, 'root']);
    const unknownStack: Array<{ node: Record<string, unknown>; path: Array<string | number> }> = [{ node: root, path: [...scene.path, 'root'] }];
    while (unknownStack.length > 0) {
      const current = unknownStack.pop();
      if (!current) break;
      if (typeof current.node.type === 'string' && !NODE_TYPES_V1.includes(current.node.type as never)) return { protocolVersion: 1, type: 'board.error', code: 'UNKNOWN_NODE_TYPE', message: 'Unknown node type', category: 'validation', retryable: false, httpStatusHint: 422, details: { path: [...current.path, 'type'], receivedType: current.node.type } };
      const children = current.node.type === 'layout.tabs' ? current.node.tabs : current.node.children;
      if (Array.isArray(children)) children.forEach((item, index) => { if (isRecord(item) && isRecord(item.node)) unknownStack.push({ node: item.node, path: [...current.path, current.node.type === 'layout.tabs' ? 'tabs' : 'children', index, 'node'] }); });
    }
  }
  return null;
};

const guardHitlResponseBytes = (input: unknown, kind: ParserKind): BoardErrorV1 | null => {
  const candidates: unknown[] = kind === 'hitl-response' ? [input] : [];
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...value);
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'response' && isRecord(child) && typeof child.kind === 'string') candidates.push(child);
        stack.push(child);
      }
    }
  }
  for (const candidate of candidates) {
    const canonical = runDecodedKernelV1(candidate);
    if (canonical.ok && canonical.canonicalBytes.byteLength > MAX_HITL_RESPONSE_BYTES) return payloadTooLarge('hitl.response', canonical.canonicalBytes.byteLength, MAX_HITL_RESPONSE_BYTES);
  }
  return null;
};

const processKernel = <Schema extends z.ZodTypeAny>(schema: Schema, kernel: KernelResultV1<JsonValue>, kind: ParserKind): BoardParseResultV1<z.output<Schema>> => {
  if (!kernel.ok) return { ok: false, error: kernelError(kernel.issue) };
  const input = kernel.value;
  if (isRecord(input) && Object.hasOwn(input, 'protocolVersion') && input.protocolVersion !== 1) return { ok: false, error: protocolMismatch(typeof input.protocolVersion === 'number' && Number.isInteger(input.protocolVersion) && input.protocolVersion >= 0 ? input.protocolVersion : null) };
  const sceneIssue = guardSceneLimits(input, kind);
  if (sceneIssue) return { ok: false, error: sceneIssue };
  const hitlByteIssue = guardHitlResponseBytes(input, kind);
  if (hitlByteIssue) return { ok: false, error: hitlByteIssue };
  const result = applySchemaV1(schema, kernel);
  if (!result.ok) return { ok: false, error: mapSchemaIssue(input, result.issue, kind) };
  return { ok: true, data: { value: result.value, canonicalBytes: result.canonicalBytes } };
};

const createParser = <Schema extends z.ZodTypeAny>(schema: Schema, kind: ParserKind = 'generic'): BoardContractParserV1<z.output<Schema>> => ({
  parse: (input) => processKernel(schema, runDecodedKernelV1(input), kind),
  parseBytes: (bytes) => processKernel(schema, runBytesKernelV1(bytes), kind),
});

export const GlobalIdStringParserV1 = createParser(GlobalIdStringSchemaV1);
export const BoardIdParserV1 = createParser(BoardIdSchemaV1);
export const GrantIdParserV1 = createParser(GrantIdSchemaV1);
export const PrincipalIdParserV1 = createParser(PrincipalIdSchemaV1);
export const ShortTextParserV1 = createParser(ShortTextSchemaV1);

export const SceneParserV1 = createParser(SceneSchemaV1, 'scene');
export const BoardNodeParserV1 = createParser(BoardNodeSchemaV1, 'node');
export const MutationRequestParserV1 = createParser(MutationRequestSchemaV1, 'mutation');
export const MutationEnvelopeParserV1 = createParser(MutationEnvelopeSchemaV1, 'mutation');
export const MutationResultParserV1 = createParser(MutationResultSchemaV1, 'mutation');
export const BoardOperationRequestParserV1 = createParser(BoardOperationRequestSchemaV1, 'operation');
export const BoardOperationEnvelopeParserV1 = createParser(BoardOperationEnvelopeSchemaV1, 'operation');
export const BoardOperationResultParserV1 = createParser(BoardOperationResultSchemaV1, 'operation');
export const BoardSnapshotParserV1 = createParser(BoardSnapshotSchemaV1, 'scene');
export const BoardEventEnvelopeParserV1 = createParser(BoardEventEnvelopeSchemaV1, 'event');
export const BoardCapabilitiesParserV1 = createParser(BoardCapabilitiesSchemaV1);
export const ArtifactReferenceParserV1 = createParser(ArtifactReferenceSchemaV1);
export const ArtifactResourceParserV1 = createParser(ArtifactResourceSchemaV1);
export const ArtifactManifestParserV1 = createParser(ArtifactManifestSchemaV1);
export const ArtifactRuntimeSummaryParserV1 = createParser(ArtifactRuntimeSummarySchemaV1);
export const HitlRequestDefinitionParserV1 = createParser(HitlRequestDefinitionSchemaV1);
export const HitlResponseParserV1 = createParser(HitlResponseSchemaV1, 'hitl-response');
export const HitlInteractionParserV1 = createParser(HitlInteractionSchemaV1);
export const BoardErrorParserV1 = createParser(BoardErrorSchemaV1);

export const canonicalizeJsonV1 = (input: unknown): BoardParseResultV1<JsonValue> => {
  const result = runDecodedKernelV1(input);
  return result.ok ? { ok: true, data: { value: result.value, canonicalBytes: result.canonicalBytes } } : { ok: false, error: kernelError(result.issue) };
};

const ActorCandidateSchemaV1 = z.object({ principalKind: z.enum(['user', 'mcp_client', 'service']), principalId: PrincipalIdSchemaV1, grantId: GrantIdSchemaV1.nullable(), scopes: z.array(z.enum(CLIENT_GRANT_CAPABILITIES_V1)) }).strict();
export const normalizeActorContextV1 = (input: unknown): BoardParseResultV1<ActorContextV1> => {
  const kernel = runDecodedKernelV1(input);
  if (!kernel.ok) return { ok: false, error: kernelError(kernel.issue) };
  const parsed = ActorCandidateSchemaV1.safeParse(kernel.value);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.issues[0]?.path ?? [], parsed.error.issues[0]?.message ?? 'invalid actor') };
  const actor = { ...parsed.data, scopes: [...new Set(parsed.data.scopes)].sort() };
  const checked = ActorContextSchemaV1.safeParse(actor);
  if (!checked.success) return { ok: false, error: invalidPayload(checked.error.issues[0]?.path ?? [], checked.error.issues[0]?.message ?? 'invalid actor') };
  const canonical = canonicalizeJsonV1(checked.data);
  return canonical.ok ? { ok: true, data: { value: checked.data, canonicalBytes: canonical.data.canonicalBytes } } : canonical;
};

export const buildMutationFingerprintV1 = (envelope: MutationEnvelopeV1): BoardParseResultV1<MutationFingerprintInputV1> => {
  const parsed = MutationEnvelopeParserV1.parse(envelope);
  if (!parsed.ok) return parsed;
  const value: MutationFingerprintInputV1 = { protocolVersion: 1, boardId: parsed.data.value.boardId, expectedRevisionId: parsed.data.value.expectedRevisionId, command: parsed.data.value.command, actor: parsed.data.value.actor };
  const canonical = canonicalizeJsonV1(value);
  return canonical.ok ? { ok: true, data: { value, canonicalBytes: canonical.data.canonicalBytes } } : canonical;
};

export const buildBoardOperationFingerprintV1 = (envelope: BoardLifecycleIdempotencyEnvelopeV1): BoardParseResultV1<BoardOperationFingerprintInputV1> => {
  if (!isSortedUniqueScopesV1(envelope.actor.scopes)) return { ok: false, error: invalidPayload(['actor', 'scopes'], 'scopes must be sorted and unique') };
  const parsed = BoardOperationEnvelopeParserV1.parse(envelope);
  if (!parsed.ok) return parsed as BoardParseResultV1<BoardOperationFingerprintInputV1>;
  const request = parsed.data.value.request;
  if (request.type !== 'board.create' && request.type !== 'board.archive') return { ok: false, error: invalidPayload(['request', 'type'], 'operation is not lifecycle-idempotent') };
  const value: BoardOperationFingerprintInputV1 = request.type === 'board.create'
    ? { protocolVersion: 1, operationType: 'board.create', title: request.title, actor: parsed.data.value.actor }
    : { protocolVersion: 1, operationType: 'board.archive', boardId: request.boardId, confirm: true, actor: parsed.data.value.actor };
  const canonical = canonicalizeJsonV1(value);
  return canonical.ok ? { ok: true, data: { value, canonicalBytes: canonical.data.canonicalBytes } } : canonical;
};
