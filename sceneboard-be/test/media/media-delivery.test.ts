import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';
import {
  AccountMediaDeliveryController,
  PublicMediaDeliveryController,
} from '../../src/media/media-delivery.controller.js';
import {
  MediaDeliveryService,
  type PublicMediaDeliveryService,
} from '../../src/media/media-delivery.service.js';
import type { MediaRepository } from '../../src/media/media.repository.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';

const BOARD_ID = 'board_1';
const REVISION_ID = '123e4567-e89b-42d3-a456-426614174000';
const MEDIA_ID = 'media_1';
const bytes = Buffer.from('canonical-media');
const sha256 = createHash('sha256').update(bytes).digest();

const principal = {
  kind: 'user',
  actor: {
    principalKind: 'user',
    principalId: 'account_1',
    grantId: null,
    scopes: [],
  },
  userPk: 1n,
  sessionPk: 2n,
  familyPublicId: 'family_1',
} as unknown as ResolvedBoardPrincipalV1;

const membership = Object.freeze({
  boardPk: 3n,
  accountPk: 1n,
  membershipPk: 5n,
  membershipRole: 'owner' as const,
  membershipVersion: 7,
  capabilityEpoch: 1,
  capabilityEpochEnforced: true,
  operation: 'board.get' as const,
  surface: 'browser' as const,
  write: false,
});

const createServiceHarness = (revision = { revisionPk: '7', isHead: 1, isRetained: 1 }) => {
  const order: string[] = [];
  const connection = {
    execute: async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.startsWith('SELECT board_pk FROM boards')) {
        order.push('board');
        return [[{}]];
      }
      if (normalized.includes('FROM board_memberships')) {
        order.push('membership');
        return [
          [
            {
              membershipPk: '5',
              role: membership.membershipRole,
              version: membership.membershipVersion,
              state: 'active',
            },
          ],
        ];
      }
      if (normalized.includes('FROM board_revisions r')) {
        order.push('revision');
        return [[revision]];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const repository = {
    lockExactRevisionMediaRef: async () => {
      order.push('ref');
      return { boardPk: 3n, revisionPk: 7n, mediaId: MEDIA_ID };
    },
    findBoardOwnership: async () => {
      order.push('ownership-locator');
      return {
        boardMediaPk: 11n,
        boardPk: 3n,
        mediaPk: 13n,
        mediaId: MEDIA_ID,
        status: 'active',
        leaseExpiresAt: '2026-07-29 00:00:00.000',
        version: 1n,
      };
    },
    getCanonicalObject: async () => {
      order.push('object');
      return {
        mediaPk: 13n,
        sha256,
        bytes,
        mime: 'image/png',
        width: 1,
        height: 1,
        byteLength: bytes.byteLength,
        state: 'active',
        version: 1n,
      };
    },
    lockBoardOwnership: async () => {
      order.push('ownership-lock');
      return {
        boardMediaPk: 11n,
        boardPk: 3n,
        mediaPk: 13n,
        mediaId: MEDIA_ID,
        status: 'active',
        leaseExpiresAt: '2026-07-29 00:00:00.000',
        version: 1n,
      };
    },
  };
  const accessPolicy = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: unknown, context: unknown) => Promise<unknown>,
    ) =>
      apply(connection, {
        actor: principal.actor,
        ownerUserPk: 1n,
        accountUserPk: 1n,
        membership,
      }),
  };
  return {
    order,
    service: new MediaDeliveryService(
      accessPolicy as never,
      repository as unknown as MediaRepository,
    ),
  };
};

test('buffers account media only after the board, membership, exact ref, object, and ownership locks', async () => {
  const harness = createServiceHarness();
  const result = await harness.service.getAccount({
    principal,
    boardId: BOARD_ID,
    revisionId: REVISION_ID,
    mediaId: MEDIA_ID,
  });
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.sha256Hex, sha256.toString('hex'));
  assert.deepEqual(harness.order, [
    'board',
    'membership',
    'revision',
    'ref',
    'ownership-locator',
    'object',
    'ownership-lock',
    'membership',
    'revision',
    'ref',
  ]);
});

test('viewer retained-only access fails before any media locator or byte read', async () => {
  const harness = createServiceHarness({ revisionPk: '7', isHead: 0, isRetained: 1 });
  const viewer = { ...membership, membershipRole: 'viewer' as const };
  const service = new MediaDeliveryService(
    {
      withAuthorizedBoardTransaction: async (
        _input: unknown,
        apply: (connection: unknown, context: unknown) => Promise<unknown>,
      ) =>
        apply(
          {
            execute: async (sql: string) => {
              const normalized = sql.replace(/\s+/gu, ' ').trim();
              if (normalized.startsWith('SELECT board_pk FROM boards')) return [[{}]];
              if (normalized.includes('FROM board_memberships'))
                return [
                  [
                    {
                      membershipPk: '5',
                      role: 'viewer',
                      version: 7,
                      state: 'active',
                    },
                  ],
                ];
              if (normalized.includes('FROM board_revisions r'))
                return [[{ revisionPk: '7', isHead: 0, isRetained: 1 }]];
              throw new Error(`unexpected SQL: ${normalized}`);
            },
          },
          { membership: viewer },
        ),
    } as never,
    {
      lockExactRevisionMediaRef: async () => {
        throw new Error('media lookup must not run');
      },
    } as unknown as MediaRepository,
  );
  await assert.rejects(
    service.getAccount({
      principal,
      boardId: BOARD_ID,
      revisionId: REVISION_ID,
      mediaId: MEDIA_ID,
    }),
    (error: unknown) => error instanceof BoardContractError && error.status === 404,
  );
  assert.deepEqual(harness.order, []);
});

const responseHarness = () => {
  const headers = new Map<string, string>();
  let status = 0;
  let body: unknown;
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    status: (value: number) => {
      status = value;
      return response;
    },
    end: (value?: Buffer) => {
      body = value;
    },
    json: (value: unknown) => {
      body = value;
    },
  };
  return {
    headers,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    response,
  };
};

test('account controller reauthorizes before exact 304 and authenticated 416 responses', async () => {
  let calls = 0;
  const media = {
    getAccount: async () => {
      calls += 1;
      return {
        bytes,
        mime: 'image/png' as const,
        sha256Hex: sha256.toString('hex'),
        byteLength: bytes.byteLength,
      };
    },
  };
  const controller = new AccountMediaDeliveryController(media as never);
  const conditional = responseHarness();
  await controller.get(
    {
      headers: { 'if-none-match': `"${sha256.toString('hex')}"` },
      originalUrl: `/api/v1/boards/${BOARD_ID}/revisions/${REVISION_ID}/media/${MEDIA_ID}`,
      boardPrincipal: principal,
    },
    conditional.response,
    BOARD_ID,
    REVISION_ID,
    MEDIA_ID,
  );
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body, undefined);
  assert.equal(conditional.headers.get('ETag'), `"${sha256.toString('hex')}"`);
  const range = responseHarness();
  await controller.get(
    {
      headers: { range: 'bytes=0-1' },
      originalUrl: `/api/v1/boards/${BOARD_ID}/revisions/${REVISION_ID}/media/${MEDIA_ID}`,
      boardPrincipal: principal,
    },
    range.response,
    BOARD_ID,
    REVISION_ID,
    MEDIA_ID,
  );
  assert.equal(range.status, 416);
  assert.equal(range.headers.get('Content-Range'), `bytes */${bytes.byteLength}`);
  assert.equal(calls, 2);
});

test('public controller ignores conditionals, never emits a shared cache, and authorizes range first', async () => {
  let calls = 0;
  const service = {
    get: async () => {
      calls += 1;
      return {
        bytes,
        mime: 'image/png' as const,
        sha256Hex: sha256.toString('hex'),
        byteLength: bytes.byteLength,
      };
    },
  } as unknown as PublicMediaDeliveryService;
  const controller = new PublicMediaDeliveryController(service);
  const response = responseHarness();
  await controller.get(
    {
      headers: { 'if-none-match': `"${sha256.toString('hex')}"`, cookie: 'context=value' },
      originalUrl:
        `/api/v1/public/shares/share_1/revisions/${REVISION_ID}/g/1/1/media/${MEDIA_ID}` +
        '?contextId=context_1',
    },
    response.response,
    'share_1',
    REVISION_ID,
    '1',
    '1',
    MEDIA_ID,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private,no-store');
  assert.deepEqual(response.body, bytes);
  const ranged = responseHarness();
  await assert.rejects(
    controller.get(
      {
        headers: { range: 'bytes=0-1', cookie: 'context=value' },
        originalUrl:
          `/api/v1/public/shares/share_1/revisions/${REVISION_ID}/g/1/1/media/${MEDIA_ID}` +
          '?contextId=context_1',
      },
      ranged.response,
      'share_1',
      REVISION_ID,
      '1',
      '1',
      MEDIA_ID,
    ),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 416,
  );
  assert.equal(calls, 2);
});
