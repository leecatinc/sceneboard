import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { ControlMutationRepository } from '../revisions/control-mutation.repository.js';
import { CurrentHitlSummaryPort } from '../snapshots/ports/current-hitl-summary.port.js';
import { HitlExpiryService } from './application/hitl-expiry.service.js';
import { HitlExpirySweepService } from './application/hitl-expiry-sweep.service.js';
import { HitlLifecycleApplicationPortV1 } from './application/hitl-lifecycle-application.port.js';
import { HitlMutationApplicationPortV1 } from './application/hitl-mutation-application.port.js';
import { HitlQueryApplicationPortV1 } from './application/hitl-query-application.port.js';
import { HitlWaitCoordinator } from './application/hitl-wait-coordinator.js';
import { InteractionCommandService } from './application/interaction-command.service.js';
import { InteractionLifecycleService } from './application/interaction-lifecycle.service.js';
import { InteractionQueryService } from './application/interaction-query.service.js';
import { CurrentHitlSummaryProvider } from './current-hitl-summary.provider.js';
import { InteractionController } from './interaction.controller.js';
import { InteractionLifecycleController } from './interaction-lifecycle.controller.js';
import { InteractionRepository } from './persistence/interaction.repository.js';
import { InteractionIntegrityProbe } from './persistence/interaction-integrity.probe.js';
import { HitlAuditPolicy } from './hitl-audit.policy.js';

@Module({
  imports: [GrantModule, DatabaseModule],
  controllers: [InteractionController, InteractionLifecycleController],
  providers: [
    InteractionRepository,
    InteractionIntegrityProbe,
    ControlMutationRepository,
    HitlWaitCoordinator,
    {
      provide: HitlAuditPolicy,
      inject: [AuditRepository],
      useFactory: (audit: AuditRepository) => new HitlAuditPolicy(audit),
    },
    CurrentHitlSummaryProvider,
    { provide: CurrentHitlSummaryPort, useExisting: CurrentHitlSummaryProvider },
    {
      provide: HitlExpiryService,
      inject: [
        MysqlBoardAccessPolicy,
        InteractionRepository,
        ControlMutationRepository,
        HitlWaitCoordinator,
        HitlAuditPolicy,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        interactions: InteractionRepository,
        mutations: ControlMutationRepository,
        waits: HitlWaitCoordinator,
        audit: HitlAuditPolicy,
      ) => new HitlExpiryService(accessPolicy, interactions, mutations, waits, audit),
    },
    {
      provide: HitlExpirySweepService,
      inject: [
        MysqlService,
        InteractionRepository,
        ControlMutationRepository,
        HitlExpiryService,
        HitlWaitCoordinator,
      ],
      useFactory: (
        mysql: MysqlService,
        interactions: InteractionRepository,
        mutations: ControlMutationRepository,
        expiry: HitlExpiryService,
        waits: HitlWaitCoordinator,
      ) => new HitlExpirySweepService(mysql, interactions, mutations, expiry, waits),
    },
    {
      provide: InteractionCommandService,
      inject: [
        MysqlBoardAccessPolicy,
        InteractionRepository,
        ControlMutationRepository,
        HitlExpiryService,
        HitlWaitCoordinator,
        HitlAuditPolicy,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        interactions: InteractionRepository,
        mutations: ControlMutationRepository,
        expiry: HitlExpiryService,
        waits: HitlWaitCoordinator,
        audit: HitlAuditPolicy,
      ) =>
        new InteractionCommandService(accessPolicy, interactions, mutations, expiry, waits, audit),
    },
    { provide: HitlMutationApplicationPortV1, useExisting: InteractionCommandService },
    {
      provide: InteractionQueryService,
      inject: [
        MysqlBoardAccessPolicy,
        InteractionRepository,
        HitlExpiryService,
        HitlWaitCoordinator,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        interactions: InteractionRepository,
        expiry: HitlExpiryService,
        waits: HitlWaitCoordinator,
      ) => new InteractionQueryService(accessPolicy, interactions, expiry, waits),
    },
    { provide: HitlQueryApplicationPortV1, useExisting: InteractionQueryService },
    {
      provide: InteractionLifecycleService,
      inject: [
        MysqlBoardAccessPolicy,
        InteractionRepository,
        ControlMutationRepository,
        HitlExpiryService,
        HitlWaitCoordinator,
        HitlAuditPolicy,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        interactions: InteractionRepository,
        mutations: ControlMutationRepository,
        expiry: HitlExpiryService,
        waits: HitlWaitCoordinator,
        audit: HitlAuditPolicy,
      ) =>
        new InteractionLifecycleService(
          accessPolicy,
          interactions,
          mutations,
          expiry,
          waits,
          audit,
        ),
    },
    { provide: HitlLifecycleApplicationPortV1, useExisting: InteractionLifecycleService },
  ],
  exports: [
    HitlMutationApplicationPortV1,
    HitlQueryApplicationPortV1,
    HitlLifecycleApplicationPortV1,
    InteractionCommandService,
    InteractionQueryService,
    InteractionLifecycleService,
    CurrentHitlSummaryPort,
    CurrentHitlSummaryProvider,
  ],
})
export class InteractionsModule {}
