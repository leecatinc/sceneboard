import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { MemberCandidateV1, PrincipalId } from '@sceneboard/board-schema';

import { preserveMemberCandidateOrderV1 } from '../../lib/board/member-management-state';

test('candidate N-1/N/N+1 fixtures preserve server sequence and stable keys exactly', () => {
  for (const size of [19, 20, 21]) {
    const source: MemberCandidateV1[] = Array.from({ length: size }, (_, index) =>
      index % 2 === 0
        ? {
            kind: 'account',
            accountId: `account_${size - index}` as PrincipalId,
            displayName: `Member ${index}`,
          }
        : { kind: 'email', email: `member${size - index}@example.com` },
    );
    const rows = preserveMemberCandidateOrderV1(source);
    assert.deepEqual(
      rows.map(({ key: _key, ...candidate }) => candidate),
      source,
    );
    assert.deepEqual(
      rows.map((row) => row.key),
      source.map((candidate) =>
        candidate.kind === 'account' ? candidate.accountId : candidate.email,
      ),
    );
  }
});

test('member sheet debounces and cancels without sorting, deduping, or cutting candidates', () => {
  const source = readFileSync(
    new URL('../../components/board/MemberManagementSheet.tsx', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../../components/board/MemberManagementSheet.module.css', import.meta.url),
    'utf8',
  );
  assert.match(source, /setTimeout\(\(\) =>/u);
  assert.match(source, /preserveMemberCandidateOrderV1\(result\.value\.candidates\)/u);
  assert.doesNotMatch(source, /candidates\.(?:sort|filter|slice)\(/u);
  assert.match(source, /ConfirmationDialog/u);
  assert.match(css, /min-width:\s*min\(320px,\s*100vw\)/u);
});
