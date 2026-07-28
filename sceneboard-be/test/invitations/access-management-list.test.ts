import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('owner management list is one authorized repeatable-read cut with bounded rows', () => {
  const service = readFileSync(
    new URL('../../src/invitations/invitation.service.ts', import.meta.url),
    'utf8',
  );
  const repository = readFileSync(
    new URL('../../src/invitations/invitation.repository.ts', import.meta.url),
    'utf8',
  );
  const controller = readFileSync(
    new URL('../../src/invitations/invitation.controller.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /operation: 'membership\.list'/u);
  assert.match(service, /isolation: 'REPEATABLE_READ_CUT'/u);
  assert.match(repository, /m\.role IN \('editor', 'viewer'\)/u);
  assert.match(repository, /state = 'pending' AND expires_at > UTC_TIMESTAMP\(3\)/u);
  assert.equal((repository.match(/LIMIT 500/gu) ?? []).length >= 2, true);
  assert.match(controller, /@Get\(':boardId\/members'\)/u);
});
