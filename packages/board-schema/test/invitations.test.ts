import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AccessManagementListParserV1,
  BoardInvitationEnvelopeParserV1,
  InvitationAcceptanceParserV1,
  ManagedMembershipEnvelopeParserV1,
  MemberCandidateListParserV1,
} from '../src/index.js';

test('owner access list is strict, bounded, and excludes owner rows', () => {
  const value = {
    members: [{ memberId: 'member_1', accountId: 'account_1', role: 'editor', version: 2 }],
    invitations: [
      {
        inviteId: 'invite_1',
        role: 'viewer',
        expiresAt: '2026-08-04T00:00:00.000Z',
        state: 'pending',
      },
    ],
  };
  assert.equal(AccessManagementListParserV1.parse(value).ok, true);
  assert.equal(
    AccessManagementListParserV1.parse({
      ...value,
      members: [{ ...value.members[0], role: 'owner' }],
    }).ok,
    false,
  );
  assert.equal(AccessManagementListParserV1.parse({ ...value, unexpected: true }).ok, false);
});

test('candidate contract permits only bounded account and email shapes', () => {
  assert.equal(
    MemberCandidateListParserV1.parse({
      candidates: [
        { kind: 'account', accountId: 'account_1', displayName: 'Lee' },
        { kind: 'email', email: 'invitee@example.com' },
      ],
    }).ok,
    true,
  );
  assert.equal(
    MemberCandidateListParserV1.parse({
      candidates: [
        {
          kind: 'account',
          accountId: 'account_1',
          displayName: 'Lee',
          email: 'secret@example.com',
        },
      ],
    }).ok,
    false,
  );
  assert.equal(
    MemberCandidateListParserV1.parse({
      candidates: Array.from({ length: 21 }, (_, index) => ({
        kind: 'account',
        accountId: `account_${index}`,
        displayName: `Member ${index}`,
      })),
    }).ok,
    false,
  );
});

test('invitation and membership outcomes are strict and versioned', () => {
  assert.equal(
    BoardInvitationEnvelopeParserV1.parse({
      invitation: {
        inviteId: 'invite_1',
        role: 'viewer',
        expiresAt: '2026-08-04T00:00:00.000Z',
        state: 'pending',
      },
    }).ok,
    true,
  );
  assert.equal(
    InvitationAcceptanceParserV1.parse({
      membership: {
        boardId: 'board_1',
        accountId: 'account_1',
        role: 'editor',
        version: 1,
      },
      replayed: false,
    }).ok,
    true,
  );
  assert.equal(
    ManagedMembershipEnvelopeParserV1.parse({
      membership: { accountId: 'account_1', role: 'owner', version: 2 },
      capabilityEpoch: 3,
    }).ok,
    false,
  );
});
