import type { GrantSummary } from '../api/board-api';

export const visibleApprovedGrants = (grants: GrantSummary[]): GrantSummary[] =>
  grants.filter((grant) => grant.status === 'active' || grant.status === 'pending_redemption');

export const hasVisibleGrantForBoard = (grants: GrantSummary[], boardId: string): boolean =>
  visibleApprovedGrants(grants).some((grant) => grant.boardIds.includes(boardId));
