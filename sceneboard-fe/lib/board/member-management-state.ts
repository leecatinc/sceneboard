import type { MemberCandidateV1 } from '@sceneboard/board-schema';

export type MemberCandidateRowV1 = MemberCandidateV1 & { key: string };

export const preserveMemberCandidateOrderV1 = (
  candidates: readonly MemberCandidateV1[],
): MemberCandidateRowV1[] =>
  candidates.map((candidate) => ({
    ...candidate,
    key: candidate.kind === 'account' ? candidate.accountId : candidate.email,
  }));
