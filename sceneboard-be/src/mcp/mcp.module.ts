import { Module } from '@nestjs/common';

import { BoardModule } from '../boards/board.module.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { PresenceModule } from '../presence/presence.module.js';
import {
  AUTHORIZED_BROWSER_PRESENCE_PORT_V1,
  type AuthorizedBrowserPresencePortV1,
} from '../presence/ports/authorized-browser-presence.port.js';
import { McpConnectionController } from './mcp-connection.controller.js';
import { McpConnectionService } from './mcp-connection.service.js';

@Module({
  imports: [GrantModule, BoardModule, PresenceModule],
  controllers: [McpConnectionController],
  providers: [
    {
      provide: McpConnectionService,
      inject: [MysqlBoardAccessPolicy, AUTHORIZED_BROWSER_PRESENCE_PORT_V1],
      useFactory: (access: MysqlBoardAccessPolicy, presence: AuthorizedBrowserPresencePortV1) =>
        new McpConnectionService(access, presence),
    },
  ],
  exports: [McpConnectionService],
})
export class McpModule {}
