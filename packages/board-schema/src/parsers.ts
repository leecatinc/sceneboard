import { z } from 'zod';

import { ActorContextSchemaV1, isSortedUniqueScopesV1, type ActorContextV1 } from './actors.js';
import {
  ArtifactManifestSchemaV1,
  ArtifactReferenceSchemaV1,
  ArtifactResourceSchemaV1,
  ArtifactRuntimeSummarySchemaV1,
} from './artifacts.js';
import {
  BoardAuthorizationCapabilitySchemaV1,
  BoardCapabilitiesSchema,
  BoardCapabilitiesSchemaV1,
  BoardCapabilitiesSchemaV2,
  BoardCapabilitiesSchemaV3,
  BoardSessionAccessSchemaV1,
} from './capabilities.js';
import { CLIENT_GRANT_CAPABILITIES_V1, NODE_TYPES_V1 } from './catalogs.js';
import {
  MutationEnvelopeSchemaV1,
  MutationEnvelopeSchemaV2,
  MutationEnvelopeSchemaV3,
  MutationRequestSchemaV1,
  MutationRequestSchemaV2,
  MutationRequestSchemaV3,
  MutationResultSchemaV1,
  MutationResultSchemaV2,
  MutationResultSchemaV3,
  type MutationEnvelopeV1,
  type MutationFingerprintInputV1,
} from './commands.js';
import { BoardDocumentSchemaV2, BoardDocumentSchemaV3 } from './documents.js';
import { BoardEventEnvelopeSchemaV1, BoardEventEnvelopeSchemaV2 } from './events.js';
import type { BoardError, BoardErrorV1 } from './errors.js';
import { BoardErrorSchema, BoardErrorSchemaV1 } from './errors.js';
import {
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  GrantIdSchemaV1,
  MediaIdSchemaV1,
  NodeIdSchemaV1,
  PageIdSchemaV1,
  PrincipalIdSchemaV1,
  ShortTextSchemaV1,
} from './identifiers.js';
import { MediaIngestResultSchemaV1 } from './media.js';
import {
  HitlInteractionSchemaV1,
  HitlRequestDefinitionSchemaV1,
  HitlResponseSchemaV1,
} from './hitl.js';
import {
  AccessManagementListSchemaV1,
  BoardInvitationEnvelopeSchemaV1,
  BoardInvitationSchemaV1,
  InvitationAcceptanceSchemaV1,
  ManagedMembershipEnvelopeSchemaV1,
  MemberCandidateListSchemaV1,
  MemberCandidateSchemaV1,
} from './invitations.js';
import {
  ShareErrorEnvelopeSchemaV1,
  ShareErrorSchemaV1,
  ShareFingerprintInputSchemaV1,
  ShareIdempotencyKeySchemaV1,
  ShareLinkTokenSchemaV1,
  ShareListResultSchemaV1,
  ShareManagementViewSchemaV1,
  SharePasswordAdmissionRequestSchemaV1,
  SharePasswordReplayResultSchemaV1,
  SharePasswordSuccessSchemaV1,
  SharePublishRequestSchemaV1,
  SharePublishSuccessSchemaV1,
  ShareRotateSuccessSchemaV1,
  ShareSecretReplayResultSchemaV1,
  ShareUpdateRequestSchemaV1,
  ShareUpdateSuccessSchemaV1,
  ShareVersionRequestSchemaV1,
} from './shares.js';
import {
  PublicArtifactSummarySchemaV1,
  PublicBoardProjectionSchemaV1,
  PublicContextIdSchemaV1,
  PublicMediaResourceSchemaV1,
  PublicRelativeUrlSchemaV1,
  PublicShareContextSchemaV1,
  PublicShareStateSchemaV1,
  PublicShareTokenSchemaV1,
  QuotedSha256EtagSchemaV1,
} from './public-shares.js';
import {
  ShareAnalyticsContextRequestSchemaV1,
  ShareAnalyticsContextSchemaV1,
  ShareAnalyticsErrorEnvelopeSchemaV1,
  ShareAnalyticsEventResultSchemaV1,
  ShareAnalyticsEventSchemaV1,
  ShareAnalyticsReportSchemaV1,
} from './share-analytics.js';
import {
  PublicPresentationAnnotationSchemaV1,
  PublicPresentationEndResultSchemaV1,
  PublicPresentationEventSchemaV1,
  PublicPresentationSessionIdSchemaV1,
  PublicPresentationSessionListSchemaV1,
  PublicPresentationSnapshotSchemaV1,
  PublicPresentationStartRequestSchemaV1,
  PublicPresentationUpdateRequestSchemaV1,
} from './public-presentation-sessions.js';
import { RetainedHistoryMetadataSchemaV1 } from './history.js';
import { BoardAuthorizationPrincipalSchemaV1, BoardMembershipSchemaV1 } from './memberships.js';
import type { JsonValue } from './json.js';
import { scalarLengthV1 } from './json.js';
import {
  BOARD_LIMITS_V1,
  BOARD_DOCUMENT_LIMITS_V2,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_ENVELOPE_BYTES,
  MAX_DOCUMENT_PAGE_BYTES,
  MAX_HITL_RESPONSE_BYTES,
  MAX_SCENE_BYTES,
  type BoardLimitKeyV1,
} from './limits.js';
import {
  BoardOperationEnvelopeSchemaV1,
  BoardOperationAuthorizationMatrixSchemaV1,
  BoardOperationAuthorizationPolicySchemaV1,
  BoardOperationRequestSchemaV1,
  BoardOperationResultSchemaV1,
  type BoardLifecycleIdempotencyEnvelopeV1,
  type BoardOperationFingerprintInputV1,
} from './operations.js';
import {
  applySchemaV1,
  runDocumentBytesKernelV2,
  runBytesKernelV1,
  runDecodedKernelV1,
  type KernelIssueV1,
  type KernelResultV1,
} from './parser-kernel.js';
import { BoardNodeSchemaV1, SceneSchemaV1 } from './scene.js';
import {
  BoardSnapshotSchema,
  BoardSnapshotSchemaV1,
  BoardSnapshotSchemaV2,
  BoardSnapshotSchemaV3,
} from './snapshots.js';

export type CanonicalContractValueV1<T> = { value: T; canonicalBytes: Uint8Array };
export type BoardParseResultV1<T> =
  | { ok: true; data: CanonicalContractValueV1<T> }
  | { ok: false; error: BoardErrorV1 };
export type BoardParseResult<T> =
  | { ok: true; data: CanonicalContractValueV1<T> }
  | { ok: false; error: BoardError };
export type BoardContractParserV1<T> = {
  parse(input: unknown): BoardParseResultV1<T>;
  parseBytes(bytes: Uint8Array): BoardParseResultV1<T>;
};
export type BoardContractParser<T> = {
  parse(input: unknown): BoardParseResult<T>;
  parseBytes(bytes: Uint8Array): BoardParseResult<T>;
};

type ParserKind =
  | 'generic'
  | 'document'
  | 'scene'
  | 'node'
  | 'mutation'
  | 'operation'
  | 'event'
  | 'hitl-response';

const invalidPayload = (path: Array<string | number>, issue: string): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid payload',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { path, issue: issue.slice(0, 200) || 'invalid payload' },
});
const protocolMismatch = (
  receivedMajor: number | null,
  reason: 'major' | 'schema_revision' = 'major',
  field = 'protocolVersion',
): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'PROTOCOL_VERSION_MISMATCH',
  message: 'Protocol version mismatch',
  category: 'protocol',
  retryable: false,
  httpStatusHint: 409,
  details: { reason, supportedMajor: 1, receivedMajor, field },
});
const payloadTooLarge = (
  scope:
    | 'envelope'
    | 'scene'
    | 'hitl.response'
    | 'artifact.resource'
    | 'artifact.total'
    | 'document'
    | 'document.page'
    | 'document.envelope',
  actualBytes: number,
  maximumBytes: number,
): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Payload is too large',
  category: 'validation',
  retryable: false,
  httpStatusHint: 413,
  details: { scope, actualBytes, maximumBytes },
});
const limitExceeded = (
  limit: BoardLimitKeyV1,
  actual: number,
  path: Array<string | number>,
): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'LIMIT_EXCEEDED',
  message: 'Contract limit exceeded',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { limit, actual, maximum: BOARD_LIMITS_V1[limit], path },
});
const invalidLayout = (
  path: Array<string | number>,
  reason: 'bounds' | 'overlap' | 'reference' | 'geometry',
): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_LAYOUT',
  message: 'Layout correlation is invalid',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { path, reason },
});

const kernelError = (issue: KernelIssueV1, documentProfile = false): BoardError => {
  if (issue.kind === 'payload_too_large')
    return payloadTooLarge(
      documentProfile ? 'document.envelope' : 'envelope',
      issue.actual ?? 0,
      issue.maximum ??
        (documentProfile ? MAX_DOCUMENT_ENVELOPE_BYTES : BOARD_LIMITS_V1.maxEnvelopeBytes),
    );
  if (issue.kind === 'json_depth')
    return limitExceeded(
      'maxJsonDepth',
      issue.actual ?? BOARD_LIMITS_V1.maxJsonDepth + 1,
      issue.path,
    );
  if (issue.kind === 'json_container_entries')
    return limitExceeded(
      'maxJsonContainerEntries',
      issue.actual ?? BOARD_LIMITS_V1.maxJsonContainerEntries + 1,
      issue.path,
    );
  return invalidPayload(issue.path, issue.message);
};
const kernelErrorV1 = (issue: KernelIssueV1): BoardErrorV1 => kernelError(issue) as BoardErrorV1;

const valueAtPath = (input: unknown, path: Array<string | number>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value !== null && typeof value === 'object'
        ? (value as Record<string | number, unknown>)[key]
        : undefined,
    input,
  );
const actualSize = (value: unknown): number =>
  Array.isArray(value)
    ? value.length
    : typeof value === 'string'
      ? scalarLengthV1(value)
      : value !== null && typeof value === 'object'
        ? Object.keys(value).length
        : typeof value === 'number'
          ? value
          : 0;
const actualForLimit = (
  input: unknown,
  path: Array<string | number>,
  limit: BoardLimitKeyV1,
): number => {
  const value = valueAtPath(input, path);
  if (limit === 'maxArtifactTotalBytes' && Array.isArray(value)) {
    return value.reduce<number>(
      (total, resource) =>
        total +
        (isRecord(resource) && typeof resource.byteLength === 'number' ? resource.byteLength : 0),
      0,
    );
  }
  if (limit === 'maxTableCells') {
    const table = valueAtPath(input, path.slice(0, -1));
    if (isRecord(table) && Array.isArray(table.columns) && Array.isArray(table.rows))
      return table.columns.length * table.rows.length;
  }
  if (limit === 'maxChartPoints' && Array.isArray(value)) {
    return value.reduce<number>(
      (total, series) =>
        total + (isRecord(series) && Array.isArray(series.points) ? series.points.length : 0),
      0,
    );
  }
  return actualSize(value);
};

const inferLimitKey = (
  input: unknown,
  path: Array<string | number>,
  message: string,
): BoardLimitKeyV1 | null => {
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
  if (field === 'columns')
    return parentType === 'layout.grid' ? 'maxGridColumns' : 'maxTableColumns';
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

const invalidDocument = (
  path: Array<string | number>,
  reason:
    | 'page_count'
    | 'duplicate_page_id'
    | 'default_page_missing'
    | 'invalid_display_mode'
    | 'duplicate_node_id'
    | 'unresolved_reference'
    | 'limit',
): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_DOCUMENT',
  message: 'Invalid document',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { path, reason },
});

const mapSchemaIssue = (input: unknown, issue: KernelIssueV1, kind: ParserKind): BoardError => {
  const documentMatch = /^\[INVALID_DOCUMENT:([^\]]+)\]/u.exec(issue.message);
  if (documentMatch)
    return invalidDocument(
      issue.path,
      documentMatch[1] as
        | 'page_count'
        | 'duplicate_page_id'
        | 'default_page_missing'
        | 'invalid_display_mode'
        | 'duplicate_node_id'
        | 'unresolved_reference'
        | 'limit',
    );
  const knownDocument =
    kind === 'document' ||
    findDocumentValues(input).some(
      ({ value }) => value.schemaVersion === 2 || value.schemaVersion === 3,
    );
  if (knownDocument) {
    if (issue.path.at(-1) === 'displayMode')
      return invalidDocument(issue.path, 'invalid_display_mode');
    if (issue.message.startsWith('[DUPLICATE_NODE_ID:'))
      return invalidDocument(issue.path, 'duplicate_node_id');
    if (issue.message.includes('reference') || issue.message.includes('missing'))
      return invalidDocument(issue.path, 'unresolved_reference');
    return invalidDocument(issue.path, 'limit');
  }
  const limitMatch = /^\[LIMIT:([^\]]+)\]/.exec(issue.message);
  if (limitMatch) {
    const key = limitMatch[1] as BoardLimitKeyV1;
    if (Object.hasOwn(BOARD_LIMITS_V1, key))
      return limitExceeded(key, actualForLimit(input, issue.path, key), issue.path);
  }
  const inferredLimit = inferLimitKey(input, issue.path, issue.message);
  if (inferredLimit)
    return limitExceeded(inferredLimit, actualSize(valueAtPath(input, issue.path)), issue.path);
  if (issue.message.startsWith('[DUPLICATE_NODE_ID:')) {
    const match = /^\[DUPLICATE_NODE_ID:([^:]+):(.*)\]/.exec(issue.message);
    const duplicatePath = issue.path;
    let firstPath: Array<string | number> = [];
    try {
      firstPath = JSON.parse(match?.[2] ?? '[]') as Array<string | number>;
    } catch {
      firstPath = [];
    }
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'DUPLICATE_NODE_ID',
      message: 'Duplicate node ID',
      category: 'validation',
      retryable: false,
      httpStatusHint: 422,
      details: { nodeId: (match?.[1] ?? 'node') as never, firstPath, duplicatePath },
    };
  }
  if (issue.message.startsWith('[INVALID_LAYOUT')) {
    const reason =
      issue.message.includes(':reference') ||
      issue.message.includes('reference') ||
      issue.message.includes('correlate') ||
      issue.message.includes('missing')
        ? 'reference'
        : issue.message.includes('overlap')
          ? 'overlap'
          : issue.message.includes('geometry') || issue.message.includes('polygon')
            ? 'geometry'
            : 'bounds';
    return invalidLayout(issue.path, reason);
  }
  if (issue.message.includes('Invalid discriminator value')) {
    const received = valueAtPath(input, issue.path);
    if (
      kind === 'node' ||
      (issue.path.at(-1) === 'type' &&
        issue.path.some((part) => part === 'root' || part === 'node'))
    )
      return {
        protocolVersion: 1,
        type: 'board.error',
        code: 'UNKNOWN_NODE_TYPE',
        message: 'Unknown node type',
        category: 'validation',
        retryable: false,
        httpStatusHint: 422,
        details: { path: issue.path, receivedType: String(received ?? '') },
      };
    if (kind === 'mutation')
      return {
        protocolVersion: 1,
        type: 'board.error',
        code: 'UNKNOWN_COMMAND_TYPE',
        message: 'Unknown command type',
        category: 'validation',
        retryable: false,
        httpStatusHint: 422,
        details: { path: issue.path, receivedType: String(received ?? '') },
      };
    if (kind === 'operation')
      return {
        protocolVersion: 1,
        type: 'board.error',
        code: 'UNKNOWN_OPERATION_TYPE',
        message: 'Unknown operation type',
        category: 'validation',
        retryable: false,
        httpStatusHint: 422,
        details: { path: issue.path, receivedType: String(received ?? '') },
      };
  }
  return invalidPayload(issue.path, issue.message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const findSceneValues = (
  input: unknown,
): Array<{ value: Record<string, unknown>; path: Array<string | number> }> => {
  const scenes: Array<{ value: Record<string, unknown>; path: Array<string | number> }> = [];
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [
    { value: input, path: [] },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (
      isRecord(current.value) &&
      current.value.type === 'scene' &&
      Object.hasOwn(current.value, 'root')
    )
      scenes.push({ value: current.value, path: current.path });
    if (Array.isArray(current.value))
      current.value.forEach((value, index) =>
        stack.push({ value, path: [...current.path, index] }),
      );
    else if (isRecord(current.value))
      Object.entries(current.value).forEach(([key, value]) =>
        stack.push({ value, path: [...current.path, key] }),
      );
  }
  return scenes;
};

const guardSceneLimits = (input: unknown, kind: ParserKind): BoardError | null => {
  const scenes = findSceneValues(input);
  if (kind === 'scene' && scenes.length === 0 && isRecord(input))
    scenes.push({ value: input, path: [] });
  for (const scene of scenes) {
    const canonical = runDecodedKernelV1(scene.value);
    if (canonical.ok && canonical.canonicalBytes.byteLength > MAX_SCENE_BYTES)
      return payloadTooLarge('scene', canonical.canonicalBytes.byteLength, MAX_SCENE_BYTES);
    const root = scene.value.root;
    if (root === null || !isRecord(root)) continue;
    let count = 0;
    const stack: Array<{
      node: Record<string, unknown>;
      path: Array<string | number>;
      depth: number;
    }> = [{ node: root, path: [...scene.path, 'root'], depth: 1 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      count += 1;
      if (current.depth > BOARD_LIMITS_V1.maxSceneDepth)
        return limitExceeded('maxSceneDepth', current.depth, current.path);
      const type = current.node.type;
      if (
        type === 'content.table' &&
        Array.isArray(current.node.rows) &&
        current.node.rows.length > BOARD_LIMITS_V1.maxTableRows
      )
        return limitExceeded('maxTableRows', current.node.rows.length, [...current.path, 'rows']);
      if (type === 'content.chart' && Array.isArray(current.node.series)) {
        const points = current.node.series.reduce<number>(
          (total, series) =>
            total + (isRecord(series) && Array.isArray(series.points) ? series.points.length : 0),
          0,
        );
        if (points > BOARD_LIMITS_V1.maxChartPoints)
          return limitExceeded('maxChartPoints', points, [...current.path, 'series']);
      }
      const children = type === 'layout.tabs' ? current.node.tabs : current.node.children;
      if (Array.isArray(children))
        children.forEach((item, index) => {
          if (isRecord(item) && isRecord(item.node))
            stack.push({
              node: item.node,
              path: [...current.path, type === 'layout.tabs' ? 'tabs' : 'children', index, 'node'],
              depth: current.depth + 1,
            });
        });
    }
    if (count > BOARD_LIMITS_V1.maxSceneNodes)
      return limitExceeded('maxSceneNodes', count, [...scene.path, 'root']);
    const unknownStack: Array<{ node: Record<string, unknown>; path: Array<string | number> }> = [
      { node: root, path: [...scene.path, 'root'] },
    ];
    while (unknownStack.length > 0) {
      const current = unknownStack.pop();
      if (!current) break;
      if (
        typeof current.node.type === 'string' &&
        !NODE_TYPES_V1.includes(current.node.type as never)
      )
        return {
          protocolVersion: 1,
          type: 'board.error',
          code: 'UNKNOWN_NODE_TYPE',
          message: 'Unknown node type',
          category: 'validation',
          retryable: false,
          httpStatusHint: 422,
          details: { path: [...current.path, 'type'], receivedType: current.node.type },
        };
      const children =
        current.node.type === 'layout.tabs' ? current.node.tabs : current.node.children;
      if (Array.isArray(children))
        children.forEach((item, index) => {
          if (isRecord(item) && isRecord(item.node))
            unknownStack.push({
              node: item.node,
              path: [
                ...current.path,
                current.node.type === 'layout.tabs' ? 'tabs' : 'children',
                index,
                'node',
              ],
            });
        });
    }
  }
  return null;
};

const findDocumentValues = (
  input: unknown,
): Array<{ value: Record<string, unknown>; path: Array<string | number> }> => {
  const documents: Array<{ value: Record<string, unknown>; path: Array<string | number> }> = [];
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [
    { value: input, path: [] },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (
      isRecord(current.value) &&
      Object.hasOwn(current.value, 'schemaVersion') &&
      Object.hasOwn(current.value, 'pages') &&
      Object.hasOwn(current.value, 'defaultPageId')
    )
      documents.push({ value: current.value, path: current.path });
    if (Array.isArray(current.value))
      current.value.forEach((value, index) =>
        stack.push({ value, path: [...current.path, index] }),
      );
    else if (isRecord(current.value))
      Object.entries(current.value).forEach(([key, value]) =>
        stack.push({ value, path: [...current.path, key] }),
      );
  }
  return documents;
};

const guardDocumentLimits = (
  input: unknown,
  kind: ParserKind,
  documentSchemaVersions: readonly number[],
): BoardError | null => {
  const documents = findDocumentValues(input);
  if (kind === 'document' && documents.length === 0 && isRecord(input))
    documents.push({ value: input, path: [] });
  for (const document of documents) {
    if (
      typeof document.value.schemaVersion !== 'number' ||
      !documentSchemaVersions.includes(document.value.schemaVersion)
    )
      return protocolMismatch(1, 'schema_revision', 'document.schemaVersion');
    const canonical = runDecodedKernelV1(document.value);
    if (canonical.ok && canonical.canonicalBytes.byteLength > MAX_DOCUMENT_BYTES)
      return payloadTooLarge('document', canonical.canonicalBytes.byteLength, MAX_DOCUMENT_BYTES);
    const pages = document.value.pages;
    if (!Array.isArray(pages)) continue;
    if (pages.length < 1 || pages.length > BOARD_DOCUMENT_LIMITS_V2.maxDocumentPages)
      return invalidDocument([...document.path, 'pages'], 'page_count');
    let nodeCount = 0;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      const pageCanonical = runDecodedKernelV1(page);
      if (pageCanonical.ok && pageCanonical.canonicalBytes.byteLength > MAX_DOCUMENT_PAGE_BYTES)
        return payloadTooLarge(
          'document.page',
          pageCanonical.canonicalBytes.byteLength,
          MAX_DOCUMENT_PAGE_BYTES,
        );
      if (!isRecord(page) || !isRecord(page.scene)) continue;
      const root = page.scene.root;
      if (root === null || !isRecord(root)) continue;
      const stack: Record<string, unknown>[] = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        nodeCount += 1;
        const children = node.type === 'layout.tabs' ? node.tabs : node.children;
        if (Array.isArray(children))
          children.forEach((item) => {
            if (isRecord(item) && isRecord(item.node)) stack.push(item.node);
          });
      }
    }
    if (nodeCount > BOARD_DOCUMENT_LIMITS_V2.maxDocumentNodes)
      return invalidDocument([...document.path, 'pages'], 'limit');
  }
  return null;
};

const guardHitlResponseBytes = (input: unknown, kind: ParserKind): BoardError | null => {
  const candidates: unknown[] = kind === 'hitl-response' ? [input] : [];
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...value);
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'response' && isRecord(child) && typeof child.kind === 'string')
          candidates.push(child);
        stack.push(child);
      }
    }
  }
  for (const candidate of candidates) {
    const canonical = runDecodedKernelV1(candidate);
    if (canonical.ok && canonical.canonicalBytes.byteLength > MAX_HITL_RESPONSE_BYTES)
      return payloadTooLarge(
        'hitl.response',
        canonical.canonicalBytes.byteLength,
        MAX_HITL_RESPONSE_BYTES,
      );
  }
  return null;
};

const processKernel = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  kernel: KernelResultV1<JsonValue>,
  kind: ParserKind,
  documentProfile = false,
  documentSchemaVersions: readonly number[] = [2],
): BoardParseResult<z.output<Schema>> => {
  if (!kernel.ok) return { ok: false, error: kernelError(kernel.issue, documentProfile) };
  const input = kernel.value;
  if (isRecord(input) && Object.hasOwn(input, 'protocolVersion') && input.protocolVersion !== 1)
    return {
      ok: false,
      error: protocolMismatch(
        typeof input.protocolVersion === 'number' &&
          Number.isInteger(input.protocolVersion) &&
          input.protocolVersion >= 0
          ? input.protocolVersion
          : null,
      ),
    };
  const sceneIssue = guardSceneLimits(input, kind);
  if (sceneIssue) return { ok: false, error: sceneIssue };
  const documentIssue = guardDocumentLimits(input, kind, documentSchemaVersions);
  if (documentIssue) return { ok: false, error: documentIssue };
  const hitlByteIssue = guardHitlResponseBytes(input, kind);
  if (hitlByteIssue) return { ok: false, error: hitlByteIssue };
  const result = applySchemaV1(schema, kernel);
  if (!result.ok) return { ok: false, error: mapSchemaIssue(input, result.issue, kind) };
  return { ok: true, data: { value: result.value, canonicalBytes: result.canonicalBytes } };
};

const createParser = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  kind: ParserKind = 'generic',
  documentProfile = false,
  documentSchemaVersions: readonly number[] = [2],
): BoardContractParser<z.output<Schema>> => ({
  parse: (input) =>
    processKernel(schema, runDecodedKernelV1(input), kind, documentProfile, documentSchemaVersions),
  parseBytes: (bytes) =>
    processKernel(
      schema,
      documentProfile ? runDocumentBytesKernelV2(bytes) : runBytesKernelV1(bytes),
      kind,
      documentProfile,
      documentSchemaVersions,
    ),
});

const createParserV1 = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  kind: ParserKind = 'generic',
): BoardContractParserV1<z.output<Schema>> =>
  createParser(schema, kind) as BoardContractParserV1<z.output<Schema>>;

export const GlobalIdStringParserV1 = createParserV1(GlobalIdStringSchemaV1);
export const BoardIdParserV1 = createParserV1(BoardIdSchemaV1);
export const MediaIdParserV1 = createParserV1(MediaIdSchemaV1);
export const MediaIngestResultParserV1 = createParserV1(MediaIngestResultSchemaV1);
export const GrantIdParserV1 = createParserV1(GrantIdSchemaV1);
export const PrincipalIdParserV1 = createParserV1(PrincipalIdSchemaV1);
export const NodeIdParserV1 = createParserV1(NodeIdSchemaV1);
export const PageIdParserV1 = createParserV1(PageIdSchemaV1);
export const ShortTextParserV1 = createParserV1(ShortTextSchemaV1);

export const SceneParserV1 = createParserV1(SceneSchemaV1, 'scene');
export const BoardNodeParserV1 = createParserV1(BoardNodeSchemaV1, 'node');
export const MutationRequestParserV1 = createParserV1(MutationRequestSchemaV1, 'mutation');
export const MutationEnvelopeParserV1 = createParserV1(MutationEnvelopeSchemaV1, 'mutation');
export const MutationResultParserV1 = createParserV1(MutationResultSchemaV1, 'mutation');
export const BoardOperationRequestParserV1 = createParserV1(
  BoardOperationRequestSchemaV1,
  'operation',
);
export const BoardOperationEnvelopeParserV1 = createParserV1(
  BoardOperationEnvelopeSchemaV1,
  'operation',
);
export const BoardOperationResultParserV1 = createParserV1(
  BoardOperationResultSchemaV1,
  'operation',
);
export const BoardSnapshotParserV1 = createParserV1(BoardSnapshotSchemaV1, 'scene');
export const BoardEventEnvelopeParserV1 = createParserV1(BoardEventEnvelopeSchemaV1, 'event');
export const BoardCapabilitiesParserV1 = createParserV1(BoardCapabilitiesSchemaV1);
export const BoardSessionAccessParserV1 = createParserV1(BoardSessionAccessSchemaV1);
export const ArtifactReferenceParserV1 = createParserV1(ArtifactReferenceSchemaV1);
export const ArtifactResourceParserV1 = createParserV1(ArtifactResourceSchemaV1);
export const ArtifactManifestParserV1 = createParserV1(ArtifactManifestSchemaV1);
export const ArtifactRuntimeSummaryParserV1 = createParserV1(ArtifactRuntimeSummarySchemaV1);
export const HitlRequestDefinitionParserV1 = createParserV1(HitlRequestDefinitionSchemaV1);
export const HitlResponseParserV1 = createParserV1(HitlResponseSchemaV1, 'hitl-response');
export const HitlInteractionParserV1 = createParserV1(HitlInteractionSchemaV1);
export const RetainedHistoryMetadataParserV1 = createParserV1(RetainedHistoryMetadataSchemaV1);
export const BoardMembershipParserV1 = createParserV1(BoardMembershipSchemaV1);
export const MemberCandidateParserV1 = createParserV1(MemberCandidateSchemaV1);
export const MemberCandidateListParserV1 = createParserV1(MemberCandidateListSchemaV1);
export const BoardInvitationParserV1 = createParserV1(BoardInvitationSchemaV1);
export const BoardInvitationEnvelopeParserV1 = createParserV1(BoardInvitationEnvelopeSchemaV1);
export const InvitationAcceptanceParserV1 = createParserV1(InvitationAcceptanceSchemaV1);
export const ManagedMembershipEnvelopeParserV1 = createParserV1(ManagedMembershipEnvelopeSchemaV1);
export const AccessManagementListParserV1 = createParserV1(AccessManagementListSchemaV1);
export const ShareManagementViewParserV1 = createParserV1(ShareManagementViewSchemaV1);
export const ShareListResultParserV1 = createParserV1(ShareListResultSchemaV1);
export const SharePublishRequestParserV1 = createParserV1(SharePublishRequestSchemaV1);
export const ShareUpdateRequestParserV1 = createParserV1(ShareUpdateRequestSchemaV1);
export const ShareVersionRequestParserV1 = createParserV1(ShareVersionRequestSchemaV1);
export const SharePasswordAdmissionRequestParserV1 = createParserV1(
  SharePasswordAdmissionRequestSchemaV1,
);
export const SharePublishSuccessParserV1 = createParserV1(SharePublishSuccessSchemaV1);
export const ShareRotateSuccessParserV1 = createParserV1(ShareRotateSuccessSchemaV1);
export const ShareUpdateSuccessParserV1 = createParserV1(ShareUpdateSuccessSchemaV1);
export const ShareSecretReplayResultParserV1 = createParserV1(ShareSecretReplayResultSchemaV1);
export const SharePasswordSuccessParserV1 = createParserV1(SharePasswordSuccessSchemaV1);
export const SharePasswordReplayResultParserV1 = createParserV1(SharePasswordReplayResultSchemaV1);
export const ShareErrorParserV1 = createParserV1(ShareErrorSchemaV1);
export const ShareErrorEnvelopeParserV1 = createParserV1(ShareErrorEnvelopeSchemaV1);
export const ShareFingerprintInputParserV1 = createParserV1(ShareFingerprintInputSchemaV1);
export const ShareIdempotencyKeyParserV1 = createParserV1(ShareIdempotencyKeySchemaV1);
export const ShareLinkTokenParserV1 = createParserV1(ShareLinkTokenSchemaV1);
export const PublicShareTokenParserV1 = createParserV1(PublicShareTokenSchemaV1);
export const PublicContextIdParserV1 = createParserV1(PublicContextIdSchemaV1);
export const PublicRelativeUrlParserV1 = createParserV1(PublicRelativeUrlSchemaV1);
export const QuotedSha256EtagParserV1 = createParserV1(QuotedSha256EtagSchemaV1);
export const PublicShareContextParserV1 = createParserV1(PublicShareContextSchemaV1);
export const PublicArtifactSummaryParserV1 = createParserV1(PublicArtifactSummarySchemaV1);
export const PublicMediaResourceParserV1 = createParserV1(PublicMediaResourceSchemaV1);
export const PublicBoardProjectionParserV1 = createParser(
  PublicBoardProjectionSchemaV1,
  'generic',
  true,
  [2, 3],
);
export const PublicShareStateParserV1 = createParser(
  PublicShareStateSchemaV1,
  'generic',
  true,
  [2, 3],
);
export const PublicPresentationSessionIdParserV1 = createParserV1(
  PublicPresentationSessionIdSchemaV1,
);
export const PublicPresentationAnnotationParserV1 = createParserV1(
  PublicPresentationAnnotationSchemaV1,
);
export const PublicPresentationSessionListParserV1 = createParserV1(
  PublicPresentationSessionListSchemaV1,
);
export const PublicPresentationStartRequestParserV1 = createParserV1(
  PublicPresentationStartRequestSchemaV1,
);
export const PublicPresentationSnapshotParserV1 = createParserV1(
  PublicPresentationSnapshotSchemaV1,
);
export const PublicPresentationUpdateRequestParserV1 = createParserV1(
  PublicPresentationUpdateRequestSchemaV1,
);
export const PublicPresentationEventParserV1 = createParserV1(PublicPresentationEventSchemaV1);
export const PublicPresentationEndResultParserV1 = createParserV1(
  PublicPresentationEndResultSchemaV1,
);
export const ShareAnalyticsContextRequestParserV1 = createParserV1(
  ShareAnalyticsContextRequestSchemaV1,
);
export const ShareAnalyticsContextParserV1 = createParserV1(ShareAnalyticsContextSchemaV1);
export const ShareAnalyticsEventParserV1 = createParserV1(ShareAnalyticsEventSchemaV1);
export const ShareAnalyticsEventResultParserV1 = createParserV1(ShareAnalyticsEventResultSchemaV1);
export const ShareAnalyticsReportParserV1 = createParserV1(ShareAnalyticsReportSchemaV1);
export const ShareAnalyticsErrorEnvelopeParserV1 = createParserV1(
  ShareAnalyticsErrorEnvelopeSchemaV1,
);
export const BoardAuthorizationPrincipalParserV1 = createParserV1(
  BoardAuthorizationPrincipalSchemaV1,
);
export const BoardAuthorizationCapabilityParserV1 = createParserV1(
  BoardAuthorizationCapabilitySchemaV1,
);
export const BoardOperationAuthorizationPolicyParserV1 = createParserV1(
  BoardOperationAuthorizationPolicySchemaV1,
);
export const BoardOperationAuthorizationMatrixParserV1 = createParserV1(
  BoardOperationAuthorizationMatrixSchemaV1,
);
export const BoardErrorParserV1 = createParserV1(BoardErrorSchemaV1);

export const BoardDocumentParserV2 = createParser(BoardDocumentSchemaV2, 'document', true);
export const BoardDocumentParserV3 = createParser(BoardDocumentSchemaV3, 'document', true, [3]);
export const MutationRequestParserV2 = createParser(MutationRequestSchemaV2, 'mutation', true);
export const MutationEnvelopeParserV2 = createParser(MutationEnvelopeSchemaV2, 'mutation', true);
export const MutationResultParserV2 = createParser(MutationResultSchemaV2, 'mutation', true);
export const MutationRequestParserV3 = createParser(MutationRequestSchemaV3, 'mutation', true, [3]);
export const MutationEnvelopeParserV3 = createParser(
  MutationEnvelopeSchemaV3,
  'mutation',
  true,
  [3],
);
export const MutationResultParserV3 = createParser(MutationResultSchemaV3, 'mutation', true, [3]);
export const BoardOperationResultParserV2 = createParser(
  BoardOperationResultSchemaV1,
  'operation',
  true,
);
export const BoardOperationResultParserV3 = createParser(
  BoardOperationResultSchemaV1,
  'operation',
  true,
  [3],
);
export const BoardSnapshotParserV2 = createParser(BoardSnapshotSchemaV2, 'document', true);
export const BoardSnapshotParserV3 = createParser(BoardSnapshotSchemaV3, 'document', true, [3]);
export const BoardSnapshotParser = createParser(BoardSnapshotSchema, 'generic', true, [2, 3]);
export const BoardEventEnvelopeParserV2 = createParser(BoardEventEnvelopeSchemaV2, 'event', true);
export const BoardEventEnvelopeParserV3 = createParser(
  BoardEventEnvelopeSchemaV2,
  'event',
  true,
  [3],
);
export const BoardCapabilitiesParserV2 = createParser(BoardCapabilitiesSchemaV2);
export const BoardCapabilitiesParserV3 = createParser(BoardCapabilitiesSchemaV3);
export const BoardCapabilitiesParser = createParser(BoardCapabilitiesSchema);
export const BoardErrorParser = createParser(BoardErrorSchema);

export const canonicalizeJsonV1 = (input: unknown): BoardParseResultV1<JsonValue> => {
  const result = runDecodedKernelV1(input);
  return result.ok
    ? { ok: true, data: { value: result.value, canonicalBytes: result.canonicalBytes } }
    : { ok: false, error: kernelErrorV1(result.issue) };
};

const ActorCandidateSchemaV1 = z
  .object({
    principalKind: z.enum(['user', 'mcp_client', 'service']),
    principalId: PrincipalIdSchemaV1,
    grantId: GrantIdSchemaV1.nullable(),
    scopes: z.array(z.enum(CLIENT_GRANT_CAPABILITIES_V1)),
  })
  .strict();
export const normalizeActorContextV1 = (input: unknown): BoardParseResultV1<ActorContextV1> => {
  const kernel = runDecodedKernelV1(input);
  if (!kernel.ok) return { ok: false, error: kernelErrorV1(kernel.issue) };
  const parsed = ActorCandidateSchemaV1.safeParse(kernel.value);
  if (!parsed.success)
    return {
      ok: false,
      error: invalidPayload(
        parsed.error.issues[0]?.path ?? [],
        parsed.error.issues[0]?.message ?? 'invalid actor',
      ),
    };
  const actor = { ...parsed.data, scopes: [...new Set(parsed.data.scopes)].sort() };
  const checked = ActorContextSchemaV1.safeParse(actor);
  if (!checked.success)
    return {
      ok: false,
      error: invalidPayload(
        checked.error.issues[0]?.path ?? [],
        checked.error.issues[0]?.message ?? 'invalid actor',
      ),
    };
  const canonical = canonicalizeJsonV1(checked.data);
  return canonical.ok
    ? { ok: true, data: { value: checked.data, canonicalBytes: canonical.data.canonicalBytes } }
    : canonical;
};

export const buildMutationFingerprintV1 = (
  envelope: MutationEnvelopeV1,
): BoardParseResultV1<MutationFingerprintInputV1> => {
  const parsed = MutationEnvelopeParserV1.parse(envelope);
  if (!parsed.ok) return parsed;
  const value: MutationFingerprintInputV1 = {
    protocolVersion: 1,
    boardId: parsed.data.value.boardId,
    expectedRevisionId: parsed.data.value.expectedRevisionId,
    command: parsed.data.value.command,
    actor: parsed.data.value.actor,
  };
  const canonical = canonicalizeJsonV1(value);
  return canonical.ok
    ? { ok: true, data: { value, canonicalBytes: canonical.data.canonicalBytes } }
    : canonical;
};

export const buildBoardOperationFingerprintV1 = (
  envelope: BoardLifecycleIdempotencyEnvelopeV1,
): BoardParseResultV1<BoardOperationFingerprintInputV1> => {
  if (!isSortedUniqueScopesV1(envelope.actor.scopes))
    return {
      ok: false,
      error: invalidPayload(['actor', 'scopes'], 'scopes must be sorted and unique'),
    };
  const parsed = BoardOperationEnvelopeParserV1.parse(envelope);
  if (!parsed.ok) return parsed as BoardParseResultV1<BoardOperationFingerprintInputV1>;
  const request = parsed.data.value.request;
  if (request.type !== 'board.create' && request.type !== 'board.archive')
    return {
      ok: false,
      error: invalidPayload(['request', 'type'], 'operation is not lifecycle-idempotent'),
    };
  const value: BoardOperationFingerprintInputV1 =
    request.type === 'board.create'
      ? {
          protocolVersion: 1,
          operationType: 'board.create',
          title: request.title,
          actor: parsed.data.value.actor,
        }
      : {
          protocolVersion: 1,
          operationType: 'board.archive',
          boardId: request.boardId,
          confirm: true,
          actor: parsed.data.value.actor,
        };
  const canonical = canonicalizeJsonV1(value);
  return canonical.ok
    ? { ok: true, data: { value, canonicalBytes: canonical.data.canonicalBytes } }
    : canonical;
};
