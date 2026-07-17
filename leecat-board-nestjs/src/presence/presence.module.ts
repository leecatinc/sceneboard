import { Module } from '@nestjs/common';

import {
  AuthorizedBrowserPresenceService,
  BROWSER_PRESENCE_STATUS_READER_V1,
} from './authorized-browser-presence.service.js';
import { AUTHORIZED_BROWSER_PRESENCE_PORT_V1 } from './ports/authorized-browser-presence.port.js';
import { RedisPresenceRepository } from './redis-presence.repository.js';

@Module({
  providers: [
    RedisPresenceRepository,
    {
      provide: BROWSER_PRESENCE_STATUS_READER_V1,
      useExisting: RedisPresenceRepository,
    },
    AuthorizedBrowserPresenceService,
    {
      provide: AUTHORIZED_BROWSER_PRESENCE_PORT_V1,
      useExisting: AuthorizedBrowserPresenceService,
    },
  ],
  exports: [AUTHORIZED_BROWSER_PRESENCE_PORT_V1, RedisPresenceRepository],
})
export class PresenceModule {}

export {
  AUTHORIZED_BROWSER_PRESENCE_PORT_V1,
  type AuthorizedBrowserPresencePortV1,
  type AuthorizedBrowserPresenceSubjectV1,
} from './ports/authorized-browser-presence.port.js';
