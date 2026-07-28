import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { MediaController } from './media.controller.js';
import { MediaIngestionService } from './media-ingestion.service.js';
import { loadMediaNativeCertificationEvidence } from './media-native-certification.js';
import { MysqlMediaOwnershipProvider } from './media-ownership.provider.js';
import { MediaOwnershipPort } from './media-ownership.port.js';
import { MediaRepository } from './media.repository.js';
import { MEDIA_WRITER_GATE, MediaWriterGate } from './media-writer-gate.js';

const UNAVAILABLE_MEDIA_DIGESTS = Object.freeze({
  migration: 'unavailable',
  projection: 'unavailable',
  nativeManifest: 'unavailable',
});

@Module({
  imports: [GrantModule],
  controllers: [MediaController],
  providers: [
    MediaRepository,
    {
      provide: MEDIA_WRITER_GATE,
      useFactory: () =>
        new MediaWriterGate(
          new Date().toISOString(),
          loadMediaNativeCertificationEvidence()?.artifactDigests ?? UNAVAILABLE_MEDIA_DIGESTS,
        ),
    },
    {
      provide: MediaOwnershipPort,
      inject: [MEDIA_WRITER_GATE],
      useFactory: (gate: MediaWriterGate) => new MysqlMediaOwnershipProvider(gate),
    },
    {
      provide: MediaIngestionService,
      inject: [MysqlBoardAccessPolicy, MediaRepository, MEDIA_WRITER_GATE, AuditRepository],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        repository: MediaRepository,
        gate: MediaWriterGate,
        audit: AuditRepository,
      ) => new MediaIngestionService(accessPolicy, repository, gate, audit),
    },
  ],
  exports: [MediaOwnershipPort, MediaRepository, MEDIA_WRITER_GATE],
})
export class MediaModule {}
