import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  GlobalIdStringParserV1,
  type ArtifactId,
  type ArtifactRequestCapabilityV1,
  type BoardId,
  type IdempotencyKey,
  type RevisionId,
} from '@leecat-board/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';

export type BoardArtifactPutSourceV1 = {
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  idempotencyKey: IdempotencyKey;
  artifactId: ArtifactId | null;
  html: string;
  css: string | null;
  javascript: string | null;
  requestedCapabilities: readonly ArtifactRequestCapabilityV1[];
};

export type BoardArtifactPutSourceParseResultV1 =
  | { ok: true; value: BoardArtifactPutSourceV1 }
  | { ok: false; error: ReturnType<typeof invalidBoardPayload> };

const KEYS = [
  'boardId',
  'expectedRevisionId',
  'idempotencyKey',
  'artifactId',
  'html',
  'css',
  'javascript',
  'requestedCapabilities',
] as const;

const fail = (issue: string, path: Array<string | number> = []): BoardArtifactPutSourceParseResultV1 => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return { ok: false, error };
};

const globalId = (value: unknown, path: string): string | null => {
  const parsed = GlobalIdStringParserV1.parse(value);
  return parsed.ok ? parsed.data.value : null;
};

const hasLoneSurrogate = (value: string): boolean => /[\uD800-\uDFFF]/u.test(value);

export const BoardArtifactPutSourceV1Parser = Object.freeze({
  parse(input: unknown): BoardArtifactPutSourceParseResultV1 {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('artifact_source_object');
    const source = input as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(source, key))) {
      return fail('artifact_source_exact_keys');
    }
    const boardId = globalId(source.boardId, 'boardId');
    if (boardId === null) return fail('artifact_source_board_id', ['boardId']);
    const expectedRevisionId = globalId(source.expectedRevisionId, 'expectedRevisionId');
    if (expectedRevisionId === null) return fail('artifact_source_revision_id', ['expectedRevisionId']);
    if (typeof source.idempotencyKey !== 'string'
      || source.idempotencyKey.length < 16
      || source.idempotencyKey.length > 128
      || !/^[A-Za-z0-9._:-]+$/u.test(source.idempotencyKey)) {
      return fail('artifact_source_idempotency_key', ['idempotencyKey']);
    }
    const artifactId = source.artifactId === null ? null : globalId(source.artifactId, 'artifactId');
    if (source.artifactId !== null && artifactId === null) return fail('artifact_source_artifact_id', ['artifactId']);
    for (const key of ['html', 'css', 'javascript'] as const) {
      const value = source[key];
      if (key === 'html' ? typeof value !== 'string' : value !== null && typeof value !== 'string') {
        return fail('artifact_source_text_type', [key]);
      }
      if (typeof value === 'string' && hasLoneSurrogate(value)) return fail('artifact_source_lone_surrogate', [key]);
    }
    if (!Array.isArray(source.requestedCapabilities)) {
      return fail('artifact_source_capabilities', ['requestedCapabilities']);
    }
    const requestedCapabilities = source.requestedCapabilities;
    if (requestedCapabilities.length > ARTIFACT_REQUEST_CAPABILITIES_V1.length
      || requestedCapabilities.some((value) => typeof value !== 'string'
        || !ARTIFACT_REQUEST_CAPABILITIES_V1.includes(value as ArtifactRequestCapabilityV1))) {
      return fail('artifact_source_capabilities', ['requestedCapabilities']);
    }
    for (let index = 1; index < requestedCapabilities.length; index += 1) {
      if ((requestedCapabilities[index - 1] as string) >= (requestedCapabilities[index] as string)) {
        return fail('artifact_source_capability_order', ['requestedCapabilities']);
      }
    }
    return {
      ok: true,
      value: {
        boardId: boardId as BoardId,
        expectedRevisionId: expectedRevisionId as RevisionId,
        idempotencyKey: source.idempotencyKey as IdempotencyKey,
        artifactId: artifactId as ArtifactId | null,
        html: source.html as string,
        css: source.css as string | null,
        javascript: source.javascript as string | null,
        requestedCapabilities: requestedCapabilities as ArtifactRequestCapabilityV1[],
      },
    };
  },
  parseOrThrow(input: unknown): BoardArtifactPutSourceV1 {
    const parsed = this.parse(input);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    return parsed.value;
  },
});
