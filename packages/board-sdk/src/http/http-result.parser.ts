import {
  BoardErrorParserV1,
  BoardOperationResultParserV1,
  GlobalIdStringParserV1,
  MutationResultParserV1,
  canonicalizeJsonV1,
  type ArtifactReferenceV1,
  type BoardErrorV1,
  type BoardId,
  type BoardOperationResultDataV1,
  type BoardOperationResultV1,
  type HistoryEntryV1,
  type MutationResultV1,
  type RequestId,
  type RevisionId,
} from '@sceneboard/board-schema';

import { parseStrictJsonBytesV1 } from './strict-json-response.js';

export type HistoryAdapterMetadataV1 = {
  protocolVersion: 1;
  type: 'history.adapter-metadata';
  entries: Array<{ revisionId: RevisionId; label: string }>;
  navigation: null | {
    revisionId: RevisionId;
    previousRevisionId: RevisionId | null;
    nextRevisionId: RevisionId | null;
    latestRevisionId: RevisionId;
  };
};

export type BoardHttpMetadataV1 = { history: HistoryAdapterMetadataV1 | null };

export type BoardHttpSuccessEnvelopeV1 = {
  protocolVersion: 1;
  type: 'board.http.success';
  requestId: RequestId;
  result: BoardOperationResultV1 | MutationResultV1;
  metadata: BoardHttpMetadataV1;
};

export type BoardHttpErrorResponseV1 = { error: BoardErrorV1 };

export type BoardHttpParsedResultV1 =
  | { ok: true; value: BoardHttpSuccessEnvelopeV1 }
  | { ok: false; error: BoardErrorV1 };

export type BoardHttpResultParseFailureReasonV1 =
  | 'utf8'
  | 'json'
  | 'duplicate_member'
  | 'schema'
  | 'correlation';

export type BoardHttpResultParseV1 =
  | { ok: true; value: BoardHttpParsedResultV1 }
  | { ok: false; reason: BoardHttpResultParseFailureReasonV1 };

type ParseExpectation = {
  status: number;
  requestId: RequestId;
  resultType: BoardOperationResultDataV1['type'] | MutationResultV1['result']['type'];
  boardId?: BoardId;
  artifact?: ArtifactReferenceV1;
  revisionId?: RevisionId;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validLabel = (value: unknown): value is string =>
  typeof value === 'string' &&
  [...value].length >= 1 &&
  [...value].length <= 200 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);

const parseRevisionId = (value: unknown): RevisionId | null => {
  if (typeof value !== 'string') return null;
  const parsed = GlobalIdStringParserV1.parse(value);
  return parsed.ok ? (value as RevisionId) : null;
};

const parseHistory = (value: unknown): HistoryAdapterMetadataV1 | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'type', 'entries', 'navigation']) ||
    value.protocolVersion !== 1 ||
    value.type !== 'history.adapter-metadata' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100
  )
    return null;
  const entries: HistoryAdapterMetadataV1['entries'] = [];
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['revisionId', 'label']) ||
      !validLabel(entry.label)
    )
      return null;
    const revisionId = parseRevisionId(entry.revisionId);
    if (revisionId === null) return null;
    entries.push({ revisionId, label: entry.label });
  }
  let navigation: HistoryAdapterMetadataV1['navigation'] = null;
  if (value.navigation !== null) {
    const candidate = value.navigation;
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        'revisionId',
        'previousRevisionId',
        'nextRevisionId',
        'latestRevisionId',
      ])
    )
      return null;
    const revisionId = parseRevisionId(candidate.revisionId);
    const latestRevisionId = parseRevisionId(candidate.latestRevisionId);
    const previousRevisionId =
      candidate.previousRevisionId === null ? null : parseRevisionId(candidate.previousRevisionId);
    const nextRevisionId =
      candidate.nextRevisionId === null ? null : parseRevisionId(candidate.nextRevisionId);
    if (
      revisionId === null ||
      latestRevisionId === null ||
      (candidate.previousRevisionId !== null && previousRevisionId === null) ||
      (candidate.nextRevisionId !== null && nextRevisionId === null)
    )
      return null;
    navigation = { revisionId, previousRevisionId, nextRevisionId, latestRevisionId };
  }
  const metadata: HistoryAdapterMetadataV1 = {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries,
    navigation,
  };
  const canonical = canonicalizeJsonV1(metadata);
  return canonical.ok && canonical.data.canonicalBytes.byteLength <= 131_072 ? metadata : null;
};

const historyCorrelates = (
  result: BoardOperationResultV1 | MutationResultV1,
  metadata: HistoryAdapterMetadataV1 | null,
): boolean => {
  if (result.result.type === 'history.list') {
    return (
      metadata !== null &&
      metadata.navigation === null &&
      result.result.entries.length === metadata.entries.length &&
      result.result.entries.every(
        (entry: HistoryEntryV1, index: number) =>
          entry.revision.revisionId === metadata.entries[index]?.revisionId,
      )
    );
  }
  if (result.result.type === 'history.get') {
    const revisionId = result.result.entry.revision.revisionId;
    return (
      metadata !== null &&
      metadata.entries.length === 1 &&
      metadata.entries[0]?.revisionId === revisionId &&
      metadata.navigation?.revisionId === revisionId
    );
  }
  return metadata === null;
};

const pathCorrelates = (
  result: BoardOperationResultV1 | MutationResultV1,
  expectation: ParseExpectation,
): boolean => {
  if (result.result.type !== expectation.resultType) return false;
  if (expectation.boardId !== undefined) {
    if (result.type === 'mutation.result' && result.boardId !== expectation.boardId) return false;
    if (
      (result.result.type === 'board.get' || result.result.type === 'board.create') &&
      result.result.board.boardId !== expectation.boardId
    )
      return false;
    if (
      result.result.type === 'board.archive' &&
      result.result.board.boardId !== expectation.boardId
    )
      return false;
    if (
      result.result.type === 'history.get' &&
      result.result.snapshot.boardId !== expectation.boardId
    )
      return false;
  }
  if (expectation.artifact !== undefined) {
    if (
      result.result.type !== 'artifact.get' ||
      result.result.manifest.artifact.artifactId !== expectation.artifact.artifactId ||
      result.result.manifest.artifact.versionId !== expectation.artifact.versionId
    )
      return false;
  }
  if (expectation.revisionId !== undefined && result.result.type === 'history.get') {
    return result.result.entry.revision.revisionId === expectation.revisionId;
  }
  return true;
};

export const parseBoardHttpResultV1 = (
  bytes: Uint8Array,
  expectation: ParseExpectation,
): BoardHttpResultParseV1 => {
  const strict = parseStrictJsonBytesV1(bytes);
  if (!strict.ok) return strict;
  const decoded = strict.value;
  if (!isRecord(decoded)) return { ok: false, reason: 'schema' };

  if (hasExactKeys(decoded, ['error'])) {
    const error = BoardErrorParserV1.parse(decoded.error);
    if (!error.ok) return { ok: false, reason: 'schema' };
    if (expectation.status !== error.data.value.httpStatusHint)
      return { ok: false, reason: 'correlation' };
    return { ok: true, value: { ok: false, error: error.data.value } };
  }

  if (
    !hasExactKeys(decoded, ['protocolVersion', 'type', 'requestId', 'result', 'metadata']) ||
    decoded.protocolVersion !== 1 ||
    decoded.type !== 'board.http.success' ||
    decoded.requestId !== expectation.requestId ||
    !isRecord(decoded.metadata) ||
    !hasExactKeys(decoded.metadata, ['history'])
  )
    return { ok: false, reason: 'schema' };
  const operation = BoardOperationResultParserV1.parse(decoded.result);
  const mutation = operation.ok ? null : MutationResultParserV1.parse(decoded.result);
  const result = operation.ok ? operation.data.value : mutation?.ok ? mutation.data.value : null;
  if (result === null) return { ok: false, reason: 'schema' };
  if (result.requestId !== expectation.requestId || !pathCorrelates(result, expectation)) {
    return { ok: false, reason: 'correlation' };
  }
  const historyValue = decoded.metadata.history;
  const history = historyValue === null ? null : parseHistory(historyValue);
  if ((historyValue !== null && history === null) || !historyCorrelates(result, history)) {
    return { ok: false, reason: 'correlation' };
  }
  const successStatus = result.result.type === 'board.create' && !result.replayed ? 201 : 200;
  if (expectation.status !== successStatus) return { ok: false, reason: 'correlation' };
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: expectation.requestId,
        result,
        metadata: { history },
      },
    },
  };
};
