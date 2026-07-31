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

  const created = await value.create(
    request({ displayName: 'Automation', expiresAt: metadata.expiresAt }),
  );
  assert.equal(created.metadata, metadata);
  assert.equal(
    (calls.find(([name]) => name === 'issue-service')?.[1] as { scopes?: unknown }).scopes,
    undefined,
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

test('route source is session, origin, and CSRF protected without board-principal admission', async () => {
  const source = await readFile(
    new URL('../../src/api-keys/account-api-key.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /@Controller\('api\/v1\/account\/api-keys'\)/u);
  assert.match(source, /@RequireSession\(\)/u);
  assert.equal((source.match(/@RequireOrigin\(\)/gu) ?? []).length, 3);
  assert.equal((source.match(/@RequireCsrf\('session'\)/gu) ?? []).length, 3);
  assert.doesNotMatch(source, /RequireBoardPrincipal/u);
});

test('create DTO requires a canonical expiry and preserves exact scope selection semantics', () => {
  const expiresAt = '2026-10-28T00:00:00.000Z';
  assert.deepEqual(parseAccountApiKeyCreateDto({ displayName: 'Read only', expiresAt }), {
    displayName: 'Read only',
    scopes: undefined,
    expiresAt: Date.parse(expiresAt),
  });
  assert.deepEqual(
    parseAccountApiKeyCreateDto({
      displayName: 'Writer',
      scopes: ['board:create', 'board:write'],
      expiresAt,
    }),
    {
      displayName: 'Writer',
      scopes: ['board:create', 'board:write'],
      expiresAt: Date.parse(expiresAt),
    },
  );
  for (const body of [
    { displayName: 'Missing expiry' },
    { displayName: 'Invalid month', expiresAt: '2026-13-01T00:00:00.000Z' },
    { displayName: 'Invalid day', expiresAt: '2026-02-30T00:00:00.000Z' },
    { displayName: 'Empty', scopes: [], expiresAt },
    { displayName: 'Unknown', scopes: ['unknown'], expiresAt },
    { displayName: 'Duplicate', scopes: ['board:read', 'board:read'], expiresAt },
    { displayName: 'Unsorted', scopes: ['board:write', 'board:read'], expiresAt },
    { displayName: 'Extra', expiresAt, apiKey: 'must-not-enter' },
  ]) {
    assert.throws(
      () => parseAccountApiKeyCreateDto(body),
      (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
    );
  }
});
