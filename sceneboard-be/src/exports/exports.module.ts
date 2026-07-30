import { createHmac } from 'node:crypto';

import { Module } from '@nestjs/common';

import { ArtifactRepository } from '../artifacts/artifact.repository.js';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { RedisService } from '../redis/redis.service.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  ExportAdmissionServiceV1,
  type ExportRuntimeOriginsV1,
} from './export-admission.service.js';
import { ExportAuditServiceV1 } from './export-audit.service.js';
import { ExportAuthorizationPolicyV1 } from './export-authorization.policy.js';
import { ExportCleanupServiceV1 } from './export-cleanup.service.js';
import { ExportControllerV1 } from './export.controller.js';
import { loadExportFontResourcesV1 } from './export-fonts.js';
import { ExportGlobalAdmissionRepositoryV1 } from './export-global-admission.repository.js';
import { ExportProjectionServiceV1 } from './export-projection.service.js';
import { ExportRenderBrokerServiceV1 } from './export-render-broker.service.js';
import { ExportRenderControllerV1 } from './export-render.controller.js';
import { ExportRendererServiceV1 } from './export-renderer.service.js';
import { ExportRenderSessionRepositoryV1 } from './export-render-session.repository.js';
import { ExportRevisionHoldRepositoryV1 } from './export-revision-hold.repository.js';
import { PdfExportEncoderV1 } from './pdf-export.encoder.js';
import { PptxExportEncoderV1 } from './pptx-export.encoder.js';

const EXPORT_RUNTIME_ORIGINS_V1 = Symbol('EXPORT_RUNTIME_ORIGINS_V1');
const IPV4_OCTET_V1 = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const IPV4_LOOPBACK_V1 = new RegExp(`^127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');

const canonicalLoopbackOrigin = (value: string, label: string): string => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '[::1]' &&
      parsed.hostname !== '::1' &&
      !IPV4_LOOPBACK_V1.test(parsed.hostname))
  )
    throw new TypeError(`${label} must be a canonical loopback HTTP origin`);
  return parsed.origin;
};

@Module({
  imports: [ArtifactsModule, GrantModule],
  controllers: [ExportRenderControllerV1, ExportControllerV1],
  providers: [
    DocumentCheckpointCodec,
    PdfExportEncoderV1,
    PptxExportEncoderV1,
    {
      provide: ExportAuditServiceV1,
      inject: [AuditRepository],
      useFactory: (audit: AuditRepository) => new ExportAuditServiceV1(audit),
    },
    ExportRevisionHoldRepositoryV1,
    {
      provide: ExportGlobalAdmissionRepositoryV1,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new ExportGlobalAdmissionRepositoryV1(redis),
    },
    {
      provide: EXPORT_RUNTIME_ORIGINS_V1,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment): ExportRuntimeOriginsV1 =>
        Object.freeze({
          apiOrigin: canonicalLoopbackOrigin(
            process.env.SCENEBOARD_EXPORT_API_ORIGIN ?? `http://127.0.0.1:${environment.port}`,
            'export API origin',
          ),
          webOrigin: canonicalLoopbackOrigin(
            process.env.SCENEBOARD_EXPORT_WEB_ORIGIN ?? 'http://127.0.0.1:3410',
            'export web origin',
          ),
          artifactRuntimeOrigin: canonicalLoopbackOrigin(
            process.env.SCENEBOARD_EXPORT_ARTIFACT_RUNTIME_ORIGIN ?? 'http://127.0.0.2:3412',
            'export artifact runtime origin',
          ),
        }),
    },
    {
      provide: ExportRenderSessionRepositoryV1,
      inject: [RedisService, APP_ENVIRONMENT],
      useFactory: (redis: RedisService, environment: AppEnvironment) =>
        new ExportRenderSessionRepositoryV1(
          redis,
          createHmac('sha256', environment.keys.grantToken)
            .update('sceneboard/export-render-token-hmac/v1', 'ascii')
            .digest(),
        ),
    },
    {
      provide: ExportRenderBrokerServiceV1,
      inject: [ExportRenderSessionRepositoryV1],
      useFactory: (sessions: ExportRenderSessionRepositoryV1) =>
        new ExportRenderBrokerServiceV1(sessions),
    },
    {
      provide: ExportAuthorizationPolicyV1,
      inject: [MysqlBoardAccessPolicy],
      useFactory: (boards: MysqlBoardAccessPolicy) => new ExportAuthorizationPolicyV1(boards),
    },
    {
      provide: ExportProjectionServiceV1,
      inject: [DocumentCheckpointCodec, ArtifactRepository, ExportRevisionHoldRepositoryV1],
      useFactory: (
        checkpoints: DocumentCheckpointCodec,
        artifacts: ArtifactRepository,
        holds: ExportRevisionHoldRepositoryV1,
      ) =>
        new ExportProjectionServiceV1(checkpoints, artifacts, holds, loadExportFontResourcesV1()),
    },
    {
      provide: ExportRendererServiceV1,
      inject: [ExportRenderBrokerServiceV1],
      useFactory: (broker: ExportRenderBrokerServiceV1) => new ExportRendererServiceV1(broker),
    },
    {
      provide: ExportAdmissionServiceV1,
      inject: [
        ExportAuthorizationPolicyV1,
        ExportProjectionServiceV1,
        ExportRenderSessionRepositoryV1,
        ExportRenderBrokerServiceV1,
        ExportRendererServiceV1,
        ExportGlobalAdmissionRepositoryV1,
        ExportRevisionHoldRepositoryV1,
        ExportAuditServiceV1,
        MysqlService,
        EXPORT_RUNTIME_ORIGINS_V1,
      ],
      useFactory: (
        authorization: ExportAuthorizationPolicyV1,
        projections: ExportProjectionServiceV1,
        sessions: ExportRenderSessionRepositoryV1,
        broker: ExportRenderBrokerServiceV1,
        renderer: ExportRendererServiceV1,
        globalAdmission: ExportGlobalAdmissionRepositoryV1,
        holds: ExportRevisionHoldRepositoryV1,
        audit: ExportAuditServiceV1,
        mysql: MysqlService,
        origins: ExportRuntimeOriginsV1,
      ) =>
        new ExportAdmissionServiceV1(
          authorization,
          projections,
          sessions,
          broker,
          renderer,
          globalAdmission,
          holds,
          audit,
          mysql,
          origins,
        ),
    },
    {
      provide: ExportCleanupServiceV1,
      inject: [MysqlService, ExportRevisionHoldRepositoryV1],
      useFactory: (mysql: MysqlService, holds: ExportRevisionHoldRepositoryV1) =>
        new ExportCleanupServiceV1(mysql, holds),
    },
  ],
  exports: [
    ExportRevisionHoldRepositoryV1,
    ExportRenderSessionRepositoryV1,
    ExportRenderBrokerServiceV1,
    ExportAdmissionServiceV1,
  ],
})
export class ExportsModule {}
