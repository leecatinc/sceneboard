import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { ControlMutationRepository } from '../revisions/control-mutation.repository.js';
import { CurrentArtifactRuntimeSummaryPort } from '../snapshots/ports/current-artifact-runtime-summary.port.js';
import { ArtifactApplicationPortV1 } from './artifact-application.port.js';
import { ArtifactApplicationService } from './artifact-application.service.js';
import { ArtifactAuditService } from './artifact-audit.service.js';
import { ArtifactController } from './artifact.controller.js';
import { ArtifactCapabilityBrokerService } from './artifact-capability-broker.service.js';
import { ArtifactPackageBuilderV1 } from './artifact-package.builder.js';
import { ArtifactRepository } from './artifact.repository.js';
import { ArtifactSanitizerV1 } from './artifact-sanitizer.js';
import { ArtifactSourceNormalizerV1 } from './artifact-source-normalizer.js';
import { ArtifactUsageReconciliation } from './artifact-usage-reconciliation.js';
import { CurrentArtifactRuntimeSummaryProvider } from './current-artifact-runtime-summary.provider.js';

@Module({
  imports: [GrantModule],
  controllers: [ArtifactController],
  providers: [
    ArtifactSanitizerV1,
    ArtifactPackageBuilderV1,
    {
      provide: ArtifactSourceNormalizerV1,
      inject: [ArtifactSanitizerV1, ArtifactPackageBuilderV1],
      useFactory: (sanitizer: ArtifactSanitizerV1, packages: ArtifactPackageBuilderV1) =>
        new ArtifactSourceNormalizerV1(sanitizer, packages),
    },
    ArtifactRepository,
    {
      provide: ArtifactAuditService,
      inject: [AuditRepository],
      useFactory: (audit: AuditRepository) => new ArtifactAuditService(audit),
    },
    {
      provide: ArtifactUsageReconciliation,
      inject: [ArtifactAuditService],
      useFactory: (audit: ArtifactAuditService) => new ArtifactUsageReconciliation(audit),
    },
    {
      provide: ArtifactCapabilityBrokerService,
      inject: [MysqlBoardAccessPolicy, ArtifactRepository, ArtifactAuditService],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        artifacts: ArtifactRepository,
        audit: ArtifactAuditService,
      ) => new ArtifactCapabilityBrokerService(accessPolicy, artifacts, audit),
    },
    ControlMutationRepository,
    CurrentArtifactRuntimeSummaryProvider,
    {
      provide: CurrentArtifactRuntimeSummaryPort,
      useExisting: CurrentArtifactRuntimeSummaryProvider,
    },
    {
      provide: ArtifactApplicationService,
      inject: [
        MysqlBoardAccessPolicy,
        ArtifactSourceNormalizerV1,
        ArtifactRepository,
        ControlMutationRepository,
        ArtifactAuditService,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        normalizer: ArtifactSourceNormalizerV1,
        artifacts: ArtifactRepository,
        mutations: ControlMutationRepository,
        audit: ArtifactAuditService,
      ) => new ArtifactApplicationService(accessPolicy, normalizer, artifacts, mutations, audit),
    },
    { provide: ArtifactApplicationPortV1, useExisting: ArtifactApplicationService },
  ],
  exports: [
    ArtifactApplicationPortV1,
    ArtifactApplicationService,
    CurrentArtifactRuntimeSummaryPort,
    CurrentArtifactRuntimeSummaryProvider,
  ],
})
export class ArtifactsModule {}
