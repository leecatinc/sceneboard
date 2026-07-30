import type {
  AccountApiKeyScopeV1,
  BoardCapabilitiesV1,
  BoardId,
  BoardSummaryV1,
  PrincipalId,
  GrantId,
} from '@sceneboard/board-schema';

import type { ResolvedMcpGrantProjectionV1 } from '../grants/board-access.policy.js';

type ConnectionVersionsV1 = {
  mcpServer: '0.0.0';
  boardProtocol: '1.0.0';
  api: 'v1';
};

export type SafeAuthorizedConnectionV1 =
  | {
      principal: {
        principalKind: 'mcp_client';
        principalId: PrincipalId;
        grantId: GrantId;
      };
      grant: ResolvedMcpGrantProjectionV1;
      selectedBoard: null | {
        board: BoardSummaryV1;
        capabilities: BoardCapabilitiesV1;
        capabilityEpoch: number;
        browserPresence: 'online' | 'offline' | 'unknown';
      };
      versions: ConnectionVersionsV1;
    }
  | {
      principal: {
        principalKind: 'service';
        principalId: PrincipalId;
        grantId: null;
      };
      credential: {
        keyPublicId: PrincipalId;
        scopes: readonly AccountApiKeyScopeV1[];
        status: 'active';
        expiresAt: string;
      };
      selectedBoard: null | {
        board: BoardSummaryV1;
        capabilities: BoardCapabilitiesV1;
      };
      versions: ConnectionVersionsV1;
    };

export type McpConnectionQueryV1 = {
  requestId: string;
  boardId: BoardId | null;
};
