import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('owns the eight exact owner share management paths and success statuses', async () => {
  const source = await readFile(
    new URL('../../src/shares/share.controller.ts', import.meta.url),
    'utf8',
  );
  for (const route of [
    "@Get(':boardId/shares')",
    "@Post(':boardId/shares')",
    "@Patch(':boardId/shares/:shareId')",
    "@Post(':boardId/shares/:shareId/rotate-link')",
    "@Delete(':boardId/shares/:shareId')",
    "@Post(':boardId/shares/:shareId/password')",
    "@Post(':boardId/shares/:shareId/password/regenerate')",
    "@Delete(':boardId/shares/:shareId/password')",
  ]) {
    assert.equal(source.includes(route), true, route);
  }
  assert.equal(source.includes('response.status(result.replayed ? 200 : 201)'), true);
  assert.equal(source.includes('@HttpCode(204)'), true);
  assert.equal((source.match(/@RequireCsrf\('session'\)/gu) ?? []).length, 7);
});

test('normalizes every hidden share management failure without 403 or 410', async () => {
  const source = await readFile(
    new URL('../../src/common/filters/http-error.filter.ts', import.meta.url),
    'utf8',
  );
  const shareBranch = source.slice(
    source.indexOf("if (isSharePath(request.url ?? ''))"),
    source.indexOf('if (exception instanceof BoardContractError)'),
  );
  assert.match(shareBranch, /new ShareContractError\('BOARD_NOT_FOUND'\)/u);
  assert.match(shareBranch, /new ShareContractError\('INVALID_REQUEST'\)/u);
  assert.match(shareBranch, /new ShareContractError\('RATE_LIMITED'/u);
  assert.doesNotMatch(shareBranch, /\b403\b|\b410\b/u);
});

test('uses dedicated share authorization and reports archived owner state as conflict', async () => {
  const service = await readFile(
    new URL('../../src/shares/share-publication.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /'share\.list'/u);
  assert.match(service, /'share\.publish'/u);
  assert.match(service, /'share\.update'/u);
  assert.match(service, /'share\.rotate'/u);
  assert.match(service, /'share\.revoke'/u);
  assert.doesNotMatch(service, /operation: 'membership\.(?:list|invite)'/u);
  assert.match(service, /assertBoardActive/u);
});
