import type {
  BoardCapabilitiesV1,
  BoardId,
  BoardSummaryV1,
  PrincipalId,
  GrantId,
} from '@leecat-board/board-schema';

import type { ResolvedMcpGrantProjectionV1 } from '../grants/board-access.policy.js';

export type SafeAuthorizedConnectionV1 = {
  principal: {
    principalKind: 'mcp_client';
    principalId: PrincipalId;
    grantId: GrantId;
  };
  grant: ResolvedMcpGrantProjectionV1;
  selectedBoard: null | {
    board: BoardSummaryV1;
    capabilities: BoardCapabilitiesV1;
    browserPresence: 'online' | 'offline' | 'unknown';
  };
  versions: {
    mcpServer: '0.0.0';
    boardProtocol: '1.0.0';
    api: 'v1';
  };
};

export type McpConnectionQueryV1 = {
  requestId: string;
  boardId: BoardId | null;
};
