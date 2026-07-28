import type {
  BoardAuthorizationOperationTypeV1,
  BoardAuthorizationSurfaceV1,
  BoardMembershipRoleV1,
} from '@sceneboard/board-schema';

export type MembershipAuthorizationContextV1 = Readonly<{
  boardPk: bigint;
  accountPk: bigint;
  membershipPk: bigint;
  membershipRole: BoardMembershipRoleV1;
  membershipVersion: number;
  operation: BoardAuthorizationOperationTypeV1;
  surface: BoardAuthorizationSurfaceV1;
  write: boolean;
}>;
