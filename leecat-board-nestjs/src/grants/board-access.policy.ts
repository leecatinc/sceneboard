import type {
  ActorContextV1,
  ArtifactRequestCapabilityV1,
  BoardId,
  ClientGrantCapabilityV1,
  GrantId,
} from '@leecat-board/board-schema';
import type { PoolConnection } from 'mysql2/promise';

export const AUTHORIZED_BOARD_OPERATIONS_V1 = [
  'board.list',
  'board.get',
  'capabilities.get',
  'board.create',
  'board.archive',
  'scene.replace',
  'scene.clear',
  'scene.restore',
  'history.list',
  'history.get',
  'hitl.request',
  'hitl.respond',
  'hitl.read',
  'artifact.get',
  'artifact.publish',
  'artifact.stop',
] as const;

export type AuthorizedBoardOperationV1 = (typeof AUTHORIZED_BOARD_OPERATIONS_V1)[number];
export type BrowserBoardOperationV1 = 'board.rename';
export type BoardAccessOperationV1 = AuthorizedBoardOperationV1 | BrowserBoardOperationV1;

const BOARD_ACCESS_OPERATIONS_V1: readonly BoardAccessOperationV1[] = [
  ...AUTHORIZED_BOARD_OPERATIONS_V1,
  'board.rename',
];

export type D3BoardOperationV1 = Extract<
  AuthorizedBoardOperationV1,
  | 'board.list' | 'board.get' | 'board.create' | 'board.archive'
  | 'scene.replace' | 'scene.clear' | 'scene.restore'
  | 'history.list' | 'history.get'
>;

export type ResolvedMcpGrantProjectionV1 = {
  grantId: GrantId;
  client: {
    clientId: string;
    clientName: string;
    installationFingerprint: string;
  };
  scopes: ClientGrantCapabilityV1[];
  lifecyclePermissions: Array<'board.create' | 'board.archive'>;
  boardIds: BoardId[];
  lifetime: 'session' | 'persistent';
  status: 'active';
  activatedAt: string;
  expiresAt: string;
};

export type ResolvedBoardPrincipalV1 =
  | { kind: 'user'; actor: ActorContextV1; userPk: bigint; sessionPk: bigint; familyPublicId: string }
  | { kind: 'mcp'; actor: ActorContextV1; ownerUserPk: bigint; grantPk: bigint; credentialPk: bigint; grantId: GrantId; sourceFamilyPublicId: string | null; connectionGrant?: ResolvedMcpGrantProjectionV1 };

export type CreateBoardBindingCapabilityV1 = {
  grantPk: bigint;
  grantId: GrantId;
  bindCreatedBoard(boardId: BoardId): Promise<void>;
};

export type AuthorizedBoardContextV1 = {
  actor: ActorContextV1;
  ownerUserPk: bigint;
  access:
    | { kind: 'owner'; ownerUserPk: bigint }
    | { kind: 'grant'; grantPk: bigint; grantId: GrantId };
  createBinding: CreateBoardBindingCapabilityV1 | null;
  artifactCapabilityPolicy: CurrentArtifactCapabilityPolicyV1;
};

export type CurrentArtifactCapabilityPolicyV1 = {
  allowedArtifactRequestCapabilities: readonly ArtifactRequestCapabilityV1[];
  policyEpoch: string;
};

export type AuthorizedBoardTransactionInputV1 = {
  principal: ResolvedBoardPrincipalV1;
  operation: BoardAccessOperationV1;
  boardId: BoardId | null;
  isolation: 'READ_COMMITTED_WRITE' | 'REPEATABLE_READ_CUT';
};

export interface BoardAccessPolicy {
  withAuthorizedBoardTransaction<T>(
    input: AuthorizedBoardTransactionInputV1,
    apply: (connection: PoolConnection, context: AuthorizedBoardContextV1) => Promise<T>,
  ): Promise<T>;
}

export interface AuthorizationRuleV1 {
  requiredCapabilities: readonly ClientGrantCapabilityV1[];
  requiredLifecyclePermission: 'board.create' | 'board.archive' | null;
  target: 'null' | 'board';
  activeBoardRequired: boolean;
  isolation: AuthorizedBoardTransactionInputV1['isolation'];
  applyOwner: 'D3' | 'D6' | 'D7' | 'D8';
}

const read = (
  requiredCapabilities: readonly ClientGrantCapabilityV1[],
  applyOwner: AuthorizationRuleV1['applyOwner'],
): AuthorizationRuleV1 => ({
  requiredCapabilities,
  requiredLifecyclePermission: null,
  target: 'board',
  activeBoardRequired: false,
  isolation: 'REPEATABLE_READ_CUT',
  applyOwner,
});

const write = (
  requiredCapabilities: readonly ClientGrantCapabilityV1[],
  applyOwner: AuthorizationRuleV1['applyOwner'],
): AuthorizationRuleV1 => ({
  requiredCapabilities,
  requiredLifecyclePermission: null,
  target: 'board',
  activeBoardRequired: true,
  isolation: 'READ_COMMITTED_WRITE',
  applyOwner,
});

const AUTHORIZATION_RULES: Readonly<Record<BoardAccessOperationV1, AuthorizationRuleV1>> = {
  'board.list': { ...read(['board.read'], 'D3'), target: 'null' },
  'board.get': read(['board.read'], 'D3'),
  'board.rename': write(['board.write'], 'D3'),
  'capabilities.get': read(['board.read'], 'D6'),
  'board.create': {
    ...write(['board.write'], 'D3'),
    target: 'null',
    activeBoardRequired: false,
    requiredLifecyclePermission: 'board.create',
  },
  'board.archive': {
    ...write(['board.write'], 'D3'),
    activeBoardRequired: false,
    requiredLifecyclePermission: 'board.archive',
  },
  'scene.replace': write(['board.write'], 'D3'),
  'scene.clear': write(['board.write'], 'D3'),
  'scene.restore': write(['board.write', 'board.history.read'], 'D3'),
  'history.list': read(['board.history.read'], 'D3'),
  'history.get': read(['board.history.read'], 'D3'),
  'hitl.request': write(['board.hitl.request'], 'D8'),
  'hitl.respond': write(['board.hitl.respond'], 'D8'),
  'hitl.read': read(['board.read'], 'D8'),
  'artifact.get': read(['board.read'], 'D7'),
  'artifact.publish': write(['artifact.publish'], 'D7'),
  'artifact.stop': write(['artifact.control'], 'D7'),
};

export const isBoardAccessOperation = (operation: string): operation is BoardAccessOperationV1 => (
  BOARD_ACCESS_OPERATIONS_V1.includes(operation as BoardAccessOperationV1)
);

export const authorizationRuleFor = (operation: BoardAccessOperationV1): AuthorizationRuleV1 => (
  AUTHORIZATION_RULES[operation]
);
