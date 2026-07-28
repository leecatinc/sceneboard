import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { D2_ERROR_CATALOG } from '../../src/common/errors/app-error.js';

test('owns the seven exact invitation and membership endpoint templates', async () => {
  const source = await readFile(
    new URL('../../src/invitations/invitation.controller.ts', import.meta.url),
    'utf8',
  );
  for (const route of [
    "@Get(':boardId/member-candidates')",
    "@Post(':boardId/invitations')",
    "@Post(':boardId/invitations/:inviteId/resend')",
    "@Delete(':boardId/invitations/:inviteId')",
    "@Post(':token/accept')",
    "@Patch(':boardId/members/:memberId')",
    "@Delete(':boardId/members/:memberId')",
  ]) {
    assert.equal(source.includes(route), true, route);
  }
  assert.equal((source.match(/@HttpCode\(201\)/gu) ?? []).length, 2);
  assert.equal((source.match(/@HttpCode\(204\)/gu) ?? []).length, 2);
});

test('pins invitation concealment, conflict, gone, and rate-limit statuses', () => {
  assert.equal(D2_ERROR_CATALOG.INVALID_PAYLOAD.status, 400);
  assert.equal(D2_ERROR_CATALOG.UNAUTHENTICATED.status, 401);
  assert.equal(D2_ERROR_CATALOG.INVITATION_NOT_FOUND.status, 404);
  assert.equal(D2_ERROR_CATALOG.INVITATION_CONFLICT.status, 409);
  assert.equal(D2_ERROR_CATALOG.MEMBERSHIP_CONFLICT.status, 409);
  assert.equal(D2_ERROR_CATALOG.INVITATION_GONE.status, 410);
  assert.equal(D2_ERROR_CATALOG.RATE_LIMITED.status, 429);
});

test('keeps invitation state errors on the strict D2 envelope instead of forging board errors', async () => {
  const source = await readFile(
    new URL('../../src/common/filters/http-error.filter.ts', import.meta.url),
    'utf8',
  );
  for (const code of [
    'INVITATION_NOT_FOUND',
    'INVITATION_CONFLICT',
    'INVITATION_GONE',
    'MEMBERSHIP_CONFLICT',
  ]) {
    assert.equal(source.includes(`error.code === '${code}'`), true, code);
  }
  assert.equal(source.includes("code: 'REVISION_CONFLICT'"), false);
  assert.equal(source.includes('as unknown as BoardErrorV1'), false);
  assert.equal(
    source.includes('response.status(error.status).json({ error: error.toPayload() })'),
    true,
  );
});
