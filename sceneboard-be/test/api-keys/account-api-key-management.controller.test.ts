import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { AccountApiKeyController } from '../../src/api-keys/account-api-key.controller.js';
import { parseAccountApiKeyCreateDto } from '../../src/api-keys/account-api-key.dto.js';
import { AccountApiKeyListCursorCodec } from '../../src/api-keys/account-api-key-list-cursor.codec.js';
import type { AccountApiKeyService } from '../../src/api-keys/account-api-key.service.js';
import type { SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { createCursorMacKeyV1 } from '../../src/common/security/cursor-mac-key.js';
import type { CryptoService } from '../../src/common/security/crypto.service.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';

const session: SessionRecord = {
  databaseId: '30',
  publicId: 'session_public_1',
  familyPublicId: 'family_public_1',
  tokenHash: Buffer.alloc(32),
  status: 'active',
  user: {
    databaseId: '20',
    publicId: 'user_public_1',
    email: 'fixture@example.test',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  idleExpiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
  absoluteExpiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
};

const metadata = {
  apiKeyId: 'key_public_1',
  name: 'Automation',
  prefix: 'sbk_v1.AAAAAAAA…',
  scopes: ['board:read'] as const,
  status: 'active' as const,
  createdAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-10-28T00:00:00.000Z',
  lastUsedAt: null,
};

const request = (body?: unknown) => ({
  headers: {},
  authSession: session,
  socket: { remoteAddress: '192.0.2.10' },
  ...(body === undefined ? {} : { body }),
});

const controller = (service: Partial<AccountApiKeyService>) =>
  new AccountApiKeyController(
    service as AccountApiKeyService,
    new AccountApiKeyListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 7))),
    { generatePublicIdV1: () => 'correlation_fixture_1' } as CryptoService,
    { trustedProxyCidrs: [] } as unknown as AppEnvironment,
  );

test('session management keeps default scope, limiter inputs, and safe responses', async () => {
  const calls: Array<[string, unknown]> = [];
  const value = controller({
    async consumeManagementLimits(operation, actor) {
      calls.push([operation, actor]);
    },
    async issue(input) {
      calls.push(['issue-service', input]);
      return {
        apiKey: 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        metadata,
      };
    },
    async listMetadata(input) {
      calls.push(['list-service', input]);
      return { items: [metadata], nextBoundary: null };
    },
    async revoke(input) {
      calls.push(['revoke-service', input]);
    },
  });

  const created = await value.create(request({ displayName: 'Automation', expiresInDays: 90 }));
  assert.equal(created.metadata, metadata);
  assert.equal(
    (calls.find(([name]) => name === 'issue-service')?.[1] as { scopes?: unknown }).scopes,
    undefined,
  );
  assert.equal(
    (calls.find(([name]) => name === 'issue-service')?.[1] as { expiresInDays?: unknown })
      .expiresInDays,
    90,
  );
  assert.deepEqual(await value.list({ limit: '20' }, request()), {
    items: [metadata],
    nextCursor: null,
  });
  await value.revoke('key_public_1', request());
  assert.deepEqual(
    calls.filter(([name]) => ['issue', 'list', 'revoke'].includes(name)).map(([name]) => name),
    ['issue', 'list', 'revoke'],
  );
  const actor = calls[0]![1] as Record<string, unknown>;
  assert.equal(actor.ownerUserPk, '20');
  assert.equal(actor.ownerPublicId, 'user_public_1');
  assert.equal(actor.sessionPublicId, 'session_public_1');
  assert.equal(actor.clientIp, '192.0.2.10');
});

test('cursor is owner-bound, endpoint-bound, canonical, and expires after fifteen minutes', () => {
  const codec = new AccountApiKeyListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 9)));
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  const cursor = codec.issue({
    ownerUserPk: '20',
    boundary: { createdAt: '2026-07-29T00:00:00.000Z', id: '70' },
    now,
  });
  assert.deepEqual(codec.parse({ cursor, ownerUserPk: '20', now: now + 899_999 }), {
    createdAt: '2026-07-29T00:00:00.000Z',
    id: '70',
  });
  for (const input of [
    { cursor, ownerUserPk: '21', now },
    { cursor, ownerUserPk: '20', now: now + 900_000 },
    { cursor: `${cursor.slice(0, -1)}A`, ownerUserPk: '20', now },
  ]) {
    assert.throws(
      () => codec.parse(input),
      (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
    );
  }
});

test('route source protects reads by session and same-origin fetch while mutations also require CSRF', async () => {
  const source = await readFile(
    new URL('../../src/api-keys/account-api-key.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /@Controller\('api\/v1\/account\/api-keys'\)/u);
  assert.match(source, /@RequireSession\(\)/u);
  assert.equal((source.match(/@RequireOrigin\(\)/gu) ?? []).length, 3);
  assert.equal((source.match(/@RequireCsrf\('session'\)/gu) ?? []).length, 2);
  assert.match(source, /@Get\(\)[\s\S]*?@RequireOrigin\(\)[\s\S]*?async list/u);
  assert.doesNotMatch(source, /@Get\(\)[\s\S]*?@RequireCsrf\('session'\)[\s\S]*?async list/u);
  assert.doesNotMatch(source, /RequireBoardPrincipal/u);
});

test('create DTO requires a closed duration and preserves exact scope selection semantics', () => {
  assert.deepEqual(parseAccountApiKeyCreateDto({ displayName: 'Read only', expiresInDays: 90 }), {
    displayName: 'Read only',
    scopes: undefined,
    expiresInDays: 90,
  });
  assert.deepEqual(
    parseAccountApiKeyCreateDto({
      displayName: 'Writer',
      scopes: ['board:create', 'board:write'],
      expiresInDays: 365,
    }),
    {
      displayName: 'Writer',
      scopes: ['board:create', 'board:write'],
      expiresInDays: 365,
    },
  );
  for (const body of [
    { displayName: 'Missing expiry' },
    { displayName: 'Lower boundary', expiresInDays: 29 },
    { displayName: 'Fractional', expiresInDays: 30.5 },
    { displayName: 'Upper boundary', expiresInDays: 366 },
    { displayName: 'String duration', expiresInDays: '90' },
    { displayName: 'Empty', scopes: [], expiresInDays: 90 },
    { displayName: 'Unknown', scopes: ['unknown'], expiresInDays: 90 },
    { displayName: 'Duplicate', scopes: ['board:read', 'board:read'], expiresInDays: 90 },
    { displayName: 'Unsorted', scopes: ['board:write', 'board:read'], expiresInDays: 90 },
    { displayName: 'Extra', expiresInDays: 90, expiresAt: metadata.expiresAt },
  ]) {
    assert.throws(
      () => parseAccountApiKeyCreateDto(body),
      (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
    );
  }
});

test('create DTO admits every exact database-clock expiry duration', () => {
  for (const expiresInDays of [30, 90, 365] as const) {
    assert.deepEqual(parseAccountApiKeyCreateDto({ displayName: 'Automation', expiresInDays }), {
      displayName: 'Automation',
      scopes: undefined,
      expiresInDays,
    });
  }
});

test('controller preserves every duration across positive and negative application clock skew', async () => {
  const calls: Array<{ expiresInDays: number; now: number }> = [];
  const value = controller({
    async consumeManagementLimits() {},
    async issue(input) {
      calls.push({ expiresInDays: input.expiresInDays, now: input.now });
      return {
        apiKey: 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        metadata,
      };
    },
  });
  const originalNow = Date.now;
  try {
    for (const browserNow of [0, Date.parse('2099-01-01T00:00:00.000Z')]) {
      Date.now = () => browserNow;
      for (const expiresInDays of [30, 90, 365]) {
        await value.create(request({ displayName: 'Automation', expiresInDays }));
      }
    }
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(calls, [
    { expiresInDays: 30, now: 0 },
    { expiresInDays: 90, now: 0 },
    { expiresInDays: 365, now: 0 },
    { expiresInDays: 30, now: Date.parse('2099-01-01T00:00:00.000Z') },
    { expiresInDays: 90, now: Date.parse('2099-01-01T00:00:00.000Z') },
    { expiresInDays: 365, now: Date.parse('2099-01-01T00:00:00.000Z') },
  ]);
});
