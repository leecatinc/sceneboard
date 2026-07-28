import type {
  BoardAuthorizationCapabilityV1,
  BoardSessionAccessV1,
} from '@sceneboard/board-schema';

export const BOARD_UI_OPERATION_CAPABILITIES_V1 = {
  'current.read': ['board.read'],
  'history.read': ['board.history.read'],
  'board.write': ['board.write'],
  'media.upload': ['board.media.write'],
  'scene.restore': ['board.history.read', 'board.write'],
  'connection.create': ['connection.manage.own'],
  'connection.update': ['connection.manage.own'],
  'connection.revoke': ['connection.manage.own'],
  'membership.manage': ['board.members.manage'],
  'share.manage': ['board.share.manage'],
  'board.archive': ['board.admin'],
  'board.delete': ['board.admin'],
} as const satisfies Readonly<Record<string, readonly BoardAuthorizationCapabilityV1[]>>;

export type BoardUiOperationV1 = keyof typeof BOARD_UI_OPERATION_CAPABILITIES_V1;

export type BoardAffordancesV1 = Readonly<Record<BoardUiOperationV1, boolean>>;

export type BoardCapabilityRequestIdentityV1 = {
  uiEpoch: number;
  boardId: string;
  action: string;
};

export const canPerformBoardUiOperationV1 = (
  access: BoardSessionAccessV1,
  operation: BoardUiOperationV1,
): boolean => {
  const admitted = new Set(access.authorizationCapabilities);
  return BOARD_UI_OPERATION_CAPABILITIES_V1[operation].every((capability) =>
    admitted.has(capability),
  );
};

export const deriveBoardAffordancesV1 = (access: BoardSessionAccessV1): BoardAffordancesV1 =>
  Object.freeze(
    Object.fromEntries(
      (Object.keys(BOARD_UI_OPERATION_CAPABILITIES_V1) as BoardUiOperationV1[]).map((operation) => [
        operation,
        canPerformBoardUiOperationV1(access, operation),
      ]),
    ) as Record<BoardUiOperationV1, boolean>,
  );

export const capabilitySettlementIsCurrentV1 = (
  expected: BoardCapabilityRequestIdentityV1,
  current: BoardCapabilityRequestIdentityV1 | null,
): boolean =>
  current !== null &&
  expected.uiEpoch === current.uiEpoch &&
  expected.boardId === current.boardId &&
  expected.action === current.action;

export const lostBoardUiOperationsV1 = (
  previous: BoardAffordancesV1,
  next: BoardAffordancesV1,
): readonly BoardUiOperationV1[] =>
  (Object.keys(BOARD_UI_OPERATION_CAPABILITIES_V1) as BoardUiOperationV1[]).filter(
    (operation) => previous[operation] && !next[operation],
  );

export const sameBoardSessionAccessV1 = (
  left: BoardSessionAccessV1,
  right: BoardSessionAccessV1,
): boolean =>
  left.capabilityEpoch === right.capabilityEpoch &&
  left.authorizationCapabilities.length === right.authorizationCapabilities.length &&
  left.authorizationCapabilities.every(
    (capability, index) => right.authorizationCapabilities[index] === capability,
  ) &&
  left.connectionGrantCeiling.scopes.length === right.connectionGrantCeiling.scopes.length &&
  left.connectionGrantCeiling.scopes.every(
    (scope, index) => right.connectionGrantCeiling.scopes[index] === scope,
  ) &&
  left.connectionGrantCeiling.lifecyclePermissions.length ===
    right.connectionGrantCeiling.lifecyclePermissions.length &&
  left.connectionGrantCeiling.lifecyclePermissions.every(
    (permission, index) => right.connectionGrantCeiling.lifecyclePermissions[index] === permission,
  );

export const EMPTY_BOARD_SESSION_ACCESS_V1: BoardSessionAccessV1 = Object.freeze({
  protocolVersion: 1,
  type: 'board.session.access',
  capabilityEpoch: 0,
  authorizationCapabilities: [],
  connectionGrantCeiling: {
    scopes: [],
    lifecyclePermissions: [],
  },
});
