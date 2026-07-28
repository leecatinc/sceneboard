import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardIdParserV1,
  MediaIdParserV1,
  type BoardId,
  type MediaId,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { parsePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { MembershipAuthorizationContextV1 } from '../memberships/membership-authorization.context.js';
import {
  assertPublicMediaEntitlement,
  type PublicMediaEntitlement,
  type PublicResourceEntitlementService,
} from '../shares/public-resource-entitlement.js';
import { PublicShareHttpError } from '../shares/public-share.error.js';
import { mediaBoardNotFound, mediaServiceUnavailable } from './media-errors.js';
import type { AuthorizedMediaResponseV1 } from './media-response-policy.js';
import { quotedMediaEtag } from './media-response-policy.js';
import type { LockedBoardMediaV1 } from './media-repository.types.js';
import { MediaRepository } from './media.repository.js';

interface MembershipRow extends RowDataPacket {
  membershipPk: string;
  role: 'owner' | 'editor' | 'viewer';
  version: number;
  state: 'active' | 'inactive';
}

interface RevisionRow extends RowDataPacket {
  revisionPk: string;
  isHead: number;
  isRetained: number;
}

const notFound = (): BoardContractError => new BoardContractError(mediaBoardNotFound());
const unavailable = (): BoardContractError => new BoardContractError(mediaServiceUnavailable());

const parsePk = (value: string | undefined): bigint => {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value))
    throw new BoardPersistenceError('row_integrity');
  return BigInt(value);
};

const exactDigest = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const parseIdentity = (input: {
  boardId: string;
  revisionId: string;
  mediaId: string;
}): { boardId: BoardId; revisionBytes: Buffer; mediaId: MediaId } => {
  const boardId = BoardIdParserV1.parse(input.boardId);
  const mediaId = MediaIdParserV1.parse(input.mediaId);
  if (!boardId.ok || !mediaId.ok) throw notFound();
  try {
    return {
      boardId: boardId.data.value,
      revisionBytes: Buffer.from(parsePublicUuidV4(input.revisionId)),
      mediaId: mediaId.data.value,
    };
  } catch {
    throw notFound();
  }
};

const verifyObject = (
  object: Awaited<ReturnType<MediaRepository['getCanonicalObject']>>,
): AuthorizedMediaResponseV1 => {
  if (
    object === null ||
    object.state !== 'active' ||
    object.bytes.byteLength !== object.byteLength ||
    !exactDigest(createHash('sha256').update(object.bytes).digest(), object.sha256)
  )
    throw unavailable();
  return Object.freeze({
    bytes: Buffer.from(object.bytes),
    mime: object.mime,
    sha256Hex: object.sha256.toString('hex'),
    byteLength: object.byteLength,
  });
};

export class MediaDeliveryService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly media: MediaRepository,
  ) {}

  async getAccount(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: string;
    revisionId: string;
    mediaId: string;
  }): Promise<AuthorizedMediaResponseV1> {
    const identity = parseIdentity(input);
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.get',
        boardId: identity.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const membership = context.membership;
        if (membership === null || membership === undefined) throw notFound();
        await this.lockBoard(connection, membership.boardPk);
        await this.assertMembership(connection, membership);
        const revision = await this.lockEligibleRevision(connection, {
          boardPk: membership.boardPk,
          revisionBytes: identity.revisionBytes,
          role: membership.membershipRole,
        });
        const reference = await this.media.lockExactRevisionMediaRef(connection, {
          boardPk: membership.boardPk,
          revisionPk: revision,
          mediaId: identity.mediaId,
        });
        if (reference === null) throw notFound();
        const locator = await this.locateOwnership(
          connection,
          membership.boardPk,
          identity.mediaId,
        );
        if (locator === null || locator.status !== 'active') throw notFound();
        const object = await this.media.getCanonicalObject(connection, locator.mediaPk);
        const ownership = await this.media.lockBoardOwnership(
          connection,
          membership.boardPk,
          identity.mediaId,
        );
        if (
          ownership === null ||
          ownership.status !== 'active' ||
          ownership.mediaPk !== locator.mediaPk
        )
          throw notFound();
        const authorized = verifyObject(object);
        await this.assertMembership(connection, membership);
        await this.lockEligibleRevision(connection, {
          boardPk: membership.boardPk,
          revisionBytes: identity.revisionBytes,
          role: membership.membershipRole,
        });
        if (
          (await this.media.lockExactRevisionMediaRef(connection, {
            boardPk: membership.boardPk,
            revisionPk: revision,
            mediaId: identity.mediaId,
          })) === null
        )
          throw notFound();
        return authorized;
      },
    );
  }

  private async lockBoard(connection: PoolConnection, boardPk: bigint): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT board_pk FROM boards WHERE board_pk = ? FOR UPDATE',
      [boardPk.toString()],
    );
    if (rows.length !== 1) throw notFound();
  }

  private async assertMembership(
    connection: PoolConnection,
    expected: MembershipAuthorizationContextV1,
  ): Promise<void> {
    const [rows] = await connection.execute<MembershipRow[]>(
      `
      SELECT CAST(membership_pk AS CHAR) AS membershipPk, role, version, state
      FROM board_memberships
      WHERE board_pk = ? AND account_pk = ?
      FOR UPDATE
    `,
      [expected.boardPk.toString(), expected.accountPk.toString()],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      parsePk(row.membershipPk) !== expected.membershipPk ||
      row.state !== 'active' ||
      row.role !== expected.membershipRole ||
      row.version !== expected.membershipVersion
    )
      throw notFound();
  }

  private async lockEligibleRevision(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      revisionBytes: Buffer;
      role: 'owner' | 'editor' | 'viewer';
    },
  ): Promise<bigint> {
    const [rows] = await connection.execute<RevisionRow[]>(
      `
      SELECT CAST(r.revision_pk AS CHAR) AS revisionPk,
             CASE WHEN h.revision_pk = r.revision_pk THEN 1 ELSE 0 END AS isHead,
             CASE WHEN c.revision_pk IS NULL THEN 0 ELSE 1 END AS isRetained
      FROM board_revisions r
      JOIN board_heads h ON h.board_pk = r.board_pk
      LEFT JOIN board_revision_catalog c
        ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
      WHERE r.board_pk = ? AND r.revision_id = ?
      FOR UPDATE
    `,
      [input.boardPk.toString(), input.revisionBytes],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      (input.role === 'viewer' ? row.isHead !== 1 : row.isHead !== 1 && row.isRetained !== 1)
    )
      throw notFound();
    return parsePk(row.revisionPk);
  }

  private async locateOwnership(
    connection: PoolConnection,
    boardPk: bigint,
    mediaId: MediaId,
  ): Promise<LockedBoardMediaV1 | null> {
    return this.media.findBoardOwnership(connection, boardPk, mediaId);
  }
}

export class PublicMediaDeliveryService {
  constructor(
    private readonly entitlements: PublicResourceEntitlementService,
    private readonly media: MediaRepository,
  ) {}

  async get(input: {
    shareId: string;
    revisionId: string;
    publicationGeneration: string;
    accessGeneration: string;
    mediaId: string;
    contextId: string;
    cookieHeader?: string | undefined;
  }): Promise<AuthorizedMediaResponseV1> {
    return this.entitlements.authorizeMedia({
      ...input,
      operation: (connection, entitlement) => this.readAuthorized(connection, entitlement),
    });
  }

  private async readAuthorized(
    connection: PoolConnection,
    entitlement: PublicMediaEntitlement,
  ): Promise<AuthorizedMediaResponseV1> {
    assertPublicMediaEntitlement(entitlement);
    try {
      if (
        (await this.media.lockExactRevisionMediaRef(connection, {
          boardPk: entitlement.boardPk,
          revisionPk: entitlement.revisionPk,
          mediaId: entitlement.mediaId,
        })) === null
      )
        throw new PublicShareHttpError(404);
      const locator = await this.media.findBoardOwnership(
        connection,
        entitlement.boardPk,
        entitlement.mediaId,
      );
      if (locator === null || locator.status !== 'active') throw new PublicShareHttpError(404);
      const object = await this.media.getCanonicalObject(connection, locator.mediaPk);
      const ownership = await this.media.lockBoardOwnership(
        connection,
        entitlement.boardPk,
        entitlement.mediaId,
      );
      if (
        ownership === null ||
        ownership.status !== 'active' ||
        ownership.mediaPk !== locator.mediaPk
      )
        throw new PublicShareHttpError(404);
      try {
        return verifyObject(object);
      } catch {
        throw new PublicShareHttpError(503);
      }
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
  }
}

export const accountMediaNotModified = (
  media: AuthorizedMediaResponseV1,
  ifNoneMatch: string | undefined,
): boolean => ifNoneMatch === quotedMediaEtag(media.sha256Hex);
