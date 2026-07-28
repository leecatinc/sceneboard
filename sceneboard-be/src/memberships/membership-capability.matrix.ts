import {
  BOARD_AUTHORIZATION_OPERATION_TYPES_V1,
  BOARD_OPERATION_AUTHORIZATION_MATRIX_V1,
  type BoardAuthorizationOperationTypeV1,
  type BoardAuthorizationSurfaceV1,
  type BoardMembershipRoleV1,
  type BoardOperationAuthorizationPolicyV1,
} from '@sceneboard/board-schema';

const byOperation = new Map<BoardAuthorizationOperationTypeV1, BoardOperationAuthorizationPolicyV1>(
  BOARD_OPERATION_AUTHORIZATION_MATRIX_V1.map((row) => [row.operation, row]),
);

if (
  byOperation.size !== BOARD_AUTHORIZATION_OPERATION_TYPES_V1.length ||
  BOARD_AUTHORIZATION_OPERATION_TYPES_V1.some((operation) => !byOperation.has(operation))
) {
  throw new TypeError('board authorization matrix does not exactly cover its operation catalog');
}

export const membershipPolicyFor = (
  operation: string,
  surface: BoardAuthorizationSurfaceV1,
): BoardOperationAuthorizationPolicyV1 | null => {
  const row = byOperation.get(operation as BoardAuthorizationOperationTypeV1);
  return row !== undefined && row.surfaces.includes(surface) ? row : null;
};

export const roleCanPerformBoardOperation = (
  role: BoardMembershipRoleV1,
  operation: string,
  surface: BoardAuthorizationSurfaceV1,
): boolean => membershipPolicyFor(operation, surface)?.roles[role] === true;
