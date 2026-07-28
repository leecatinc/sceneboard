import { Module } from '@nestjs/common';

import { MembershipRepository } from './membership.repository.js';
import { BoardMembershipAuthorizationService } from './membership.service.js';

@Module({
  providers: [
    MembershipRepository,
    {
      provide: BoardMembershipAuthorizationService,
      inject: [MembershipRepository],
      useFactory: (memberships: MembershipRepository) =>
        new BoardMembershipAuthorizationService(memberships),
    },
  ],
  exports: [BoardMembershipAuthorizationService],
})
export class MembershipsModule {}
