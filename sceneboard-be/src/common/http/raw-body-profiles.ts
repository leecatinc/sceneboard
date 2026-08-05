import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BOARD_LIMITS_V1,
  BOARD_DOCUMENT_LIMITS_V2,
  BoardOperationRequestParserV1,
  MutationRequestParserV1,
  MutationRequestParserV2,
  MutationRequestParserV3,
  type BoardContractParser,
  type BoardContractParserV1,
} from '@sceneboard/board-schema';

import { ArtifactBrokerError } from '../errors/artifact-broker.error.js';
import { AppError, BoardContractError } from '../errors/app-error.js';
import { boardPayloadTooLarge, invalidBoardPayload } from '../errors/board-error.factory.js';
import { parseStrictJsonBytes } from './strict-json.js';
import { invalidMediaRequest, mediaPayloadTooLarge } from '../../media/media-errors.js';

export type RawBodyProfileKind =
  | 'd2-rest-json-body'
  | 'd2-no-body'
  | 'd1-contract-body'
  | 'd1-document-contract-body'
  | 'd1-adapter-body'
  | 'd1-no-body'
  | 'd7-artifact-source-body'
  | 'd7-artifact-network-body'
  | 'd9-media-binary-body';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RawBodyProfile {
  kind: RawBodyProfileKind;
  method: HttpMethod;
  pathTemplate: string;
  mediaType?: string;
  maximumBytes?: number;
  d1Parser?: BoardContractParser<unknown> | BoardContractParserV1<unknown>;
}

const d2BodyRoutes = [
  '/api/v1/auth/signup',
  '/api/v1/auth/login',
  '/api/v1/auth/google',
  '/api/v1/auth/email-verifications',
  '/api/v1/auth/email-verifications/confirm',
  '/api/v1/auth/password',
  '/api/v1/auth/session/renew',
  '/api/v1/auth/logout',
  '/api/v1/pairings',
  '/api/v1/pairings/claim',
  '/api/v1/pairings/:pairingId/decision',
  '/api/v1/pairings/:pairingId/redeem',
  '/api/v1/boards/:boardId/title',
  '/api/v1/grants/:grantId/rotate',
  '/api/v1/public/shares/:shareId/view-contexts',
  '/api/v1/public/share-view-events',
  '/api/v1/account/api-keys',
  '/api/v1/boards/:boardId/exports',
] as const;

const d2AdditionalBodyRoutes: ReadonlyArray<readonly [HttpMethod, string]> = [
  ['POST', '/api/v1/public/share-contexts/:contextId/presentation-sessions'],
  ['POST', '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId/state'],
  ['POST', '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId/end'],
  ['POST', '/api/v1/boards/:boardId/presentation-sessions'],
  ['POST', '/api/v1/boards/:boardId/presentation-sessions/:sessionId/state'],
  ['POST', '/api/v1/boards/:boardId/presentation-sessions/:sessionId/end'],
  ['POST', '/api/v1/boards/:boardId/shares'],
  ['PATCH', '/api/v1/boards/:boardId/shares/:shareId'],
  ['POST', '/api/v1/boards/:boardId/shares/:shareId/rotate-link'],
  ['DELETE', '/api/v1/boards/:boardId/shares/:shareId'],
  ['POST', '/api/v1/boards/:boardId/shares/:shareId/password'],
  ['POST', '/api/v1/boards/:boardId/shares/:shareId/password/regenerate'],
  ['DELETE', '/api/v1/boards/:boardId/shares/:shareId/password'],
  ['POST', '/api/v1/public/shares/:shareToken/password-sessions'],
  ['POST', '/api/v1/boards/:boardId/invitations'],
  ['POST', '/api/v1/boards/:boardId/invitations/:inviteId/resend'],
  ['PATCH', '/api/v1/boards/:boardId/members/:memberId'],
  ['POST', '/api/v1/invitations/:token/accept'],
];

const d2NoBodyRoutes: ReadonlyArray<readonly [HttpMethod, string]> = [
  ['GET', '/api/v1/auth/csrf'],
  ['GET', '/api/v1/auth/session'],
  ['GET', '/api/v1/pairings/active'],
  ['GET', '/api/v1/pairings/:pairingId'],
  ['DELETE', '/api/v1/pairings/:pairingId'],
  ['GET', '/api/v1/pairings/:pairingId/client-status'],
  ['GET', '/api/v1/grants'],
  ['DELETE', '/api/v1/grants/:grantId'],
  ['GET', '/api/v1/public/shares/:shareToken'],
  ['GET', '/api/v1/public/share-contexts/:contextId'],
  ['GET', '/api/v1/public/share-contexts/:contextId/presentation-sessions'],
  ['GET', '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId'],
  ['GET', '/api/v1/public/share-contexts/:contextId/presentation-sessions/:sessionId/events'],
  ['GET', '/api/v1/boards/:boardId/presentation-sessions'],
  ['GET', '/api/v1/boards/:boardId/presentation-sessions/:sessionId'],
  ['GET', '/api/v1/boards/:boardId/presentation-sessions/:sessionId/events'],
  ['GET', '/api/v1/account/api-keys'],
  ['DELETE', '/api/v1/account/api-keys/:apiKeyId'],
  ['GET', '/api/v1/boards/:boardId/shares'],
  ['GET', '/api/v1/boards/:boardId/members'],
  ['GET', '/api/v1/boards/:boardId/member-candidates'],
  ['DELETE', '/api/v1/boards/:boardId/invitations/:inviteId'],
  ['DELETE', '/api/v1/boards/:boardId/members/:memberId'],
  [
    'GET',
    '/api/v1/public/shares/:shareId/revisions/:revisionId/g/:publicationGeneration/:accessGeneration/artifacts/:artifactId/versions/:versionId/package',
  ],
];

const d1Routes: ReadonlyArray<readonly [HttpMethod, string, BoardContractParserV1<unknown>]> = [
  ['POST', '/api/v1/boards', BoardOperationRequestParserV1],
  ['POST', '/api/v1/boards/:boardId/archive', BoardOperationRequestParserV1],
  ['POST', '/api/v1/boards/:boardId/mutations', MutationRequestParserV1],
];

const documentRoutes: ReadonlyArray<readonly [HttpMethod, string, BoardContractParser<unknown>]> = [
  ['POST', '/api/v1/boards/:boardId/mutations', MutationRequestParserV2],
];

const documentV3Routes: ReadonlyArray<readonly [HttpMethod, string, BoardContractParser<unknown>]> =
  [['POST', '/api/v1/boards/:boardId/mutations', MutationRequestParserV3]];

const d1AdapterBodyRoutes = [
  '/api/v1/boards/:boardId/revisions/:revisionId/restore',
  '/api/v1/boards/:boardId/interactions/:hitlRequestId/cancel',
  '/api/v1/boards/:boardId/interactions/:hitlRequestId/supersede',
] as const;

const d7ArtifactSourceRoutes = ['/api/v1/boards/:boardId/artifacts'] as const;

const d7ArtifactNetworkRoutes = [
  '/api/v1/boards/:boardId/artifacts/:artifactId/versions/:versionId/capability-requests/network-fetch',
] as const;

const d9MediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

const d1NoBodyRoutes: ReadonlyArray<readonly [HttpMethod, string]> = [
  ['GET', '/api/v1/mcp/connection'],
  ['GET', '/api/v1/boards'],
  ['GET', '/api/v1/boards/:boardId'],
  ['GET', '/api/v1/boards/:boardId/capabilities'],
  ['GET', '/api/v1/boards/:boardId/revisions'],
  ['GET', '/api/v1/boards/:boardId/revisions/:revisionId'],
  ['GET', '/api/v1/boards/:boardId/artifacts/:artifactId/versions/:versionId'],
  ['GET', '/api/v1/boards/:boardId/artifacts/:artifactId/versions/:versionId/package'],
  ['GET', '/api/v1/boards/:boardId/interactions/:hitlRequestId'],
  ['GET', '/api/v1/boards/:boardId/share-analytics'],
];

export const RAW_BODY_PROFILES: readonly RawBodyProfile[] = [
  ...d2BodyRoutes.map(
    (pathTemplate): RawBodyProfile => ({
      kind: 'd2-rest-json-body',
      method: 'POST',
      pathTemplate,
    }),
  ),
  ...d2AdditionalBodyRoutes.map(
    ([method, pathTemplate]): RawBodyProfile => ({
      kind: 'd2-rest-json-body',
      method,
      pathTemplate,
    }),
  ),
  ...d2NoBodyRoutes.map(
    ([method, pathTemplate]): RawBodyProfile => ({
      kind: 'd2-no-body',
      method,
      pathTemplate,
    }),
  ),
  ...d1Routes.map(
    ([method, pathTemplate, d1Parser]): RawBodyProfile => ({
      kind: 'd1-contract-body',
      method,
      pathTemplate,
      d1Parser,
    }),
  ),
  ...documentRoutes.map(
    ([method, pathTemplate, d1Parser]): RawBodyProfile => ({
      kind: 'd1-document-contract-body',
      method,
      pathTemplate,
      mediaType: 'application/vnd.sceneboard.document+json;version=2',
      d1Parser,
    }),
  ),
  ...documentV3Routes.map(
    ([method, pathTemplate, d1Parser]): RawBodyProfile => ({
      kind: 'd1-document-contract-body',
      method,
      pathTemplate,
      mediaType: 'application/vnd.sceneboard.document+json;version=3',
      d1Parser,
    }),
  ),
  ...d1AdapterBodyRoutes.map(
    (pathTemplate): RawBodyProfile => ({
      kind: 'd1-adapter-body',
      method: 'POST',
      pathTemplate,
    }),
  ),
  ...d7ArtifactSourceRoutes.map(
    (pathTemplate): RawBodyProfile => ({
      kind: 'd7-artifact-source-body',
      method: 'POST',
      pathTemplate,
    }),
  ),
  ...d7ArtifactNetworkRoutes.map(
    (pathTemplate): RawBodyProfile => ({
      kind: 'd7-artifact-network-body',
      method: 'POST',
      pathTemplate,
    }),
  ),
  ...d9MediaTypes.map(
    (mediaType): RawBodyProfile => ({
      kind: 'd9-media-binary-body',
      method: 'POST',
      pathTemplate: '/api/v1/boards/:boardId/media',
      mediaType,
      maximumBytes: 10_485_760,
    }),
  ),
  ...d1NoBodyRoutes.map(
    ([method, pathTemplate]): RawBodyProfile => ({
      kind: 'd1-no-body',
      method,
      pathTemplate,
    }),
  ),
];

const splitPath = (path: string): string[] | null => {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('//'))
    return null;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) return null;
  return segments;
};

const templateMatches = (template: string, pathname: string): boolean => {
  const expected = splitPath(template);
  const actual = splitPath(pathname);
  if (!expected || !actual || expected.length !== actual.length) return false;
  return expected.every((segment, index) =>
    segment.startsWith(':')
      ? actual[index] !== undefined && actual[index] !== ''
      : segment === actual[index],
  );
};

export const matchRawBodyProfile = (
  method: string,
  pathname: string,
  contentType?: string,
): RawBodyProfile | null => {
  const normalizedMethod = method.toUpperCase();
  const candidates = RAW_BODY_PROFILES.filter(
    (profile) =>
      profile.method === normalizedMethod && templateMatches(profile.pathTemplate, pathname),
  );
  return (
    candidates.find(
      (profile) => profile.mediaType !== undefined && profile.mediaType === contentType,
    ) ??
    candidates.find((profile) => profile.mediaType === undefined) ??
    candidates.find((profile) => profile.kind === 'd9-media-binary-body') ??
    null
  );
};

const parseContentLength = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new AppError('INVALID_PAYLOAD');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new AppError('INVALID_PAYLOAD');
  return length;
};

const assertJsonContentType = (profile: RawBodyProfile, value: string | undefined): void => {
  if (profile.mediaType !== undefined && value === profile.mediaType) return;
  if (value !== undefined && value.toLowerCase() === 'application/json' && value === value.trim())
    return;
  if (profile.kind === 'd7-artifact-network-body') {
    throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
  }
  if (
    profile.kind === 'd1-contract-body' ||
    profile.kind === 'd1-document-contract-body' ||
    profile.kind === 'd1-adapter-body' ||
    profile.kind === 'd7-artifact-source-body'
  ) {
    throw new BoardContractError(invalidBoardPayload('content type must be application/json'));
  }
  throw new AppError('INVALID_PAYLOAD');
};

export type ProfiledBodyResult =
  | { kind: 'd2-rest-json-body'; body: unknown }
  | { kind: 'd2-no-body' }
  | { kind: 'd1-no-body' }
  | { kind: 'd1-adapter-body'; rawBody: Uint8Array; parsedBody: unknown }
  | { kind: 'd7-artifact-source-body'; rawBody: Uint8Array; parsedBody: unknown }
  | { kind: 'd7-artifact-network-body'; rawBody: Uint8Array; parsedBody: unknown }
  | { kind: 'd9-media-binary-body'; rawBody: Uint8Array }
  | { kind: 'd1-contract-body'; rawBody: Uint8Array; parsedBody: unknown }
  | { kind: 'd1-document-contract-body'; rawBody: Uint8Array; parsedBody: unknown };

export interface ProfiledBodyInput {
  contentType?: string | undefined;
  contentLength?: string | undefined;
  contentEncoding?: string | undefined;
  transferEncoding?: string | undefined;
  contentDigest?: string | undefined;
  body: Uint8Array;
}

const artifactSourceTooLarge = (actualBytes: number, maximumBytes: number) => ({
  protocolVersion: 1 as const,
  type: 'board.error' as const,
  code: 'PAYLOAD_TOO_LARGE' as const,
  message: 'Payload is too large',
  category: 'validation' as const,
  retryable: false as const,
  httpStatusHint: 413 as const,
  details: { scope: 'artifact.total' as const, actualBytes, maximumBytes },
});

export const parseProfiledBody = (
  profile: RawBodyProfile,
  input: ProfiledBodyInput,
): ProfiledBodyResult => {
  if (profile.kind === 'd9-media-binary-body') {
    if (input.transferEncoding !== undefined || input.contentEncoding !== undefined)
      throw new BoardContractError(invalidMediaRequest('framing'));
    if (input.contentType !== profile.mediaType)
      throw new BoardContractError(invalidMediaRequest('content_type'));
    let declaredLength: number | null;
    try {
      declaredLength = parseContentLength(input.contentLength);
    } catch {
      throw new BoardContractError(invalidMediaRequest('length'));
    }
    if (declaredLength === null || declaredLength === 0)
      throw new BoardContractError(invalidMediaRequest('length'));
    if (declaredLength > (profile.maximumBytes ?? 10_485_760))
      throw new BoardContractError(mediaPayloadTooLarge());
    if (declaredLength !== input.body.byteLength)
      throw new BoardContractError(invalidMediaRequest('length'));
    const digestMatch = /^sha-256=:([A-Za-z0-9+/]{43}=):$/u.exec(input.contentDigest ?? '');
    if (digestMatch === null) throw new BoardContractError(invalidMediaRequest('digest'));
    const expected = Buffer.from(digestMatch[1]!, 'base64');
    if (
      expected.byteLength !== 32 ||
      expected.toString('base64') !== digestMatch[1] ||
      !timingSafeEqual(createHash('sha256').update(input.body).digest(), expected)
    )
      throw new BoardContractError(invalidMediaRequest('digest'));
    return { kind: profile.kind, rawBody: Uint8Array.from(input.body) };
  }
  if (
    profile.kind === 'd1-document-contract-body' &&
    input.contentEncoding !== undefined &&
    input.contentEncoding !== 'identity'
  ) {
    throw new BoardContractError(invalidBoardPayload('content encoding must be identity'));
  }
  let declaredLength: number | null;
  try {
    declaredLength = parseContentLength(input.contentLength);
  } catch (error) {
    if (profile.kind === 'd7-artifact-network-body') {
      throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
    }
    if (
      profile.kind === 'd1-contract-body' ||
      profile.kind === 'd1-document-contract-body' ||
      profile.kind === 'd1-adapter-body' ||
      profile.kind === 'd7-artifact-source-body'
    ) {
      throw new BoardContractError(invalidBoardPayload('invalid content length'));
    }
    throw error;
  }

  if (profile.kind === 'd2-no-body' || profile.kind === 'd1-no-body') {
    if ((declaredLength ?? input.body.byteLength) !== 0 || input.body.byteLength !== 0) {
      if (profile.kind === 'd1-no-body')
        throw new BoardContractError(invalidBoardPayload('request body is not allowed'));
      throw new AppError('INVALID_PAYLOAD');
    }
    return { kind: profile.kind };
  }

  assertJsonContentType(profile, input.contentType);
  const isD1Body =
    profile.kind === 'd1-contract-body' ||
    profile.kind === 'd1-document-contract-body' ||
    profile.kind === 'd1-adapter-body';
  const maximumBytes =
    profile.kind === 'd7-artifact-source-body'
      ? 11_534_336
      : profile.kind === 'd7-artifact-network-body'
        ? 8_192
        : profile.kind === 'd1-document-contract-body'
          ? BOARD_DOCUMENT_LIMITS_V2.maxDocumentEnvelopeBytes
          : isD1Body
            ? BOARD_LIMITS_V1.maxEnvelopeBytes
            : 65_536;
  if (declaredLength !== null && declaredLength > maximumBytes) {
    if (profile.kind === 'd7-artifact-network-body') {
      throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
    }
    if (isD1Body || profile.kind === 'd7-artifact-source-body') {
      throw new BoardContractError(
        profile.kind === 'd7-artifact-source-body'
          ? artifactSourceTooLarge(declaredLength, maximumBytes)
          : boardPayloadTooLarge(declaredLength, maximumBytes),
      );
    }
    throw new AppError('INVALID_PAYLOAD');
  }
  if (declaredLength !== null && declaredLength !== input.body.byteLength) {
    if (profile.kind === 'd7-artifact-network-body') {
      throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
    }
    if (isD1Body || profile.kind === 'd7-artifact-source-body') {
      throw new BoardContractError(invalidBoardPayload('content length mismatch'));
    }
    throw new AppError('INVALID_PAYLOAD');
  }

  if (profile.kind === 'd2-rest-json-body') {
    try {
      return { kind: profile.kind, body: parseStrictJsonBytes(input.body) };
    } catch (error) {
      throw new AppError('INVALID_PAYLOAD', { cause: error });
    }
  }

  if (input.body.byteLength > maximumBytes) {
    if (profile.kind === 'd7-artifact-network-body') {
      throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
    }
    throw new BoardContractError(
      profile.kind === 'd7-artifact-source-body'
        ? artifactSourceTooLarge(input.body.byteLength, maximumBytes)
        : boardPayloadTooLarge(input.body.byteLength, maximumBytes),
    );
  }
  if (
    profile.kind === 'd1-adapter-body' ||
    profile.kind === 'd7-artifact-source-body' ||
    profile.kind === 'd7-artifact-network-body'
  ) {
    try {
      return {
        kind: profile.kind,
        rawBody: Uint8Array.from(input.body),
        parsedBody: parseStrictJsonBytes(input.body, {
          maximumBytes,
          maximumDepth: BOARD_LIMITS_V1.maxJsonDepth,
        }),
      };
    } catch (error) {
      if (profile.kind === 'd7-artifact-network-body') {
        throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
      }
      throw new BoardContractError(
        invalidBoardPayload(error instanceof Error ? error.message : 'invalid JSON payload'),
      );
    }
  }
  const result = profile.d1Parser?.parseBytes(input.body);
  if (!result) throw new Error(`D1 profile ${profile.pathTemplate} has no parser`);
  if (!result.ok) throw new BoardContractError(result.error);
  return {
    kind: profile.kind,
    rawBody: Uint8Array.from(input.body),
    parsedBody: result.data.value,
  };
};

const routeKey = (profile: RawBodyProfile): string =>
  `${profile.method} ${profile.pathTemplate} ${profile.mediaType ?? 'default'}`;
if (new Set(RAW_BODY_PROFILES.map(routeKey)).size !== RAW_BODY_PROFILES.length) {
  throw new Error('raw-body route profiles overlap');
}
for (const profile of RAW_BODY_PROFILES) {
  if (
    (profile.kind === 'd1-contract-body' || profile.kind === 'd1-document-contract-body') &&
    !profile.d1Parser
  )
    throw new Error(`D1 profile ${routeKey(profile)} has no parser`);
  if (
    profile.kind === 'd9-media-binary-body' &&
    (profile.maximumBytes !== 10_485_760 || !d9MediaTypes.includes(profile.mediaType as never))
  )
    throw new Error(`D9 media profile ${routeKey(profile)} is invalid`);
}
