import { Module } from '@nestjs/common';

import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { MysqlCurrentBoardCapabilitiesPort } from '../grants/current-board-capabilities.port.js';
import { HistoryCursorCodec } from '../history/history-cursor.codec.js';
import { HistoryGetService } from '../history/history-get.service.js';
import { HistoryListService } from '../history/history-list.service.js';
import { InteractionsModule } from '../interactions/interactions.module.js';
import { BoardMembershipAuthorizationService } from '../memberships/membership.service.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import { BoardMutationService } from '../revisions/board-mutation.service.js';
import { SnapshotCompositionService } from '../revisions/snapshot-composition.service.js';
import { CurrentArtifactRuntimeSummaryPort } from '../snapshots/ports/current-artifact-runtime-summary.port.js';
import { CurrentHitlSummaryPort } from '../snapshots/ports/current-hitl-summary.port.js';
import { BoardCreateService } from './board-create.service.js';
import { BoardArchiveService } from './board-archive.service.js';
import { BoardCapabilitiesService } from './board-capabilities.service.js';
import { BoardGetService } from './board-get.service.js';
import { BoardListCursorCodec } from './board-list-cursor.codec.js';
import { BoardListService } from './board-list.service.js';
import { BoardRenameService } from './board-rename.service.js';
import { BoardController } from './board.controller.js';

@Module({
  imports: [GrantModule, MembershipsModule, ArtifactsModule, InteractionsModule],
  controllers: [BoardController],
  providers: [
    DocumentCheckpointCodec,
    MysqlCurrentBoardCapabilitiesPort,
    {
      provide: BoardListCursorCodec,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) =>
        new BoardListCursorCodec(environment.cursorMacKey),
    },
    {
      provide: HistoryCursorCodec,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => new HistoryCursorCodec(environment.cursorMacKey),
    },
    {
      provide: SnapshotCompositionService,
      inject: [
        CurrentHitlSummaryPort,
        CurrentArtifactRuntimeSummaryPort,
        MysqlCurrentBoardCapabilitiesPort,
      ],
      useFactory: (
        hitl: CurrentHitlSummaryPort,
        artifacts: CurrentArtifactRuntimeSummaryPort,
        capabilities: MysqlCurrentBoardCapabilitiesPort,
      ) => new SnapshotCompositionService(hitl, artifacts, capabilities),
    },
    {
      provide: BoardCreateService,
      inject: [
        MysqlBoardAccessPolicy,
        CryptoService,
        DocumentCheckpointCodec,
        BoardMembershipAuthorizationService,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        crypto: CryptoService,
        checkpointCodec: DocumentCheckpointCodec,
        memberships: BoardMembershipAuthorizationService,
      ) => new BoardCreateService(accessPolicy, crypto, checkpointCodec, {}, memberships),
    },
    {
      provide: BoardArchiveService,
      inject: [MysqlBoardAccessPolicy],
      useFactory: (accessPolicy: MysqlBoardAccessPolicy) => new BoardArchiveService(accessPolicy),
    },
    {
      provide: BoardCapabilitiesService,
      inject: [MysqlBoardAccessPolicy],
      useFactory: (accessPolicy: MysqlBoardAccessPolicy) =>
        new BoardCapabilitiesService(accessPolicy),
    },
    {
      provide: BoardGetService,
      inject: [MysqlBoardAccessPolicy, DocumentCheckpointCodec, SnapshotCompositionService],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        checkpointCodec: DocumentCheckpointCodec,
        snapshots: SnapshotCompositionService,
      ) => new BoardGetService(accessPolicy, checkpointCodec, snapshots),
    },
    {
      provide: BoardListService,
      inject: [MysqlBoardAccessPolicy, BoardListCursorCodec],
      useFactory: (accessPolicy: MysqlBoardAccessPolicy, cursors: BoardListCursorCodec) =>
        new BoardListService(accessPolicy, cursors),
    },
    {
      provide: BoardRenameService,
      inject: [MysqlBoardAccessPolicy],
      useFactory: (accessPolicy: MysqlBoardAccessPolicy) => new BoardRenameService(accessPolicy),
    },
    {
      provide: BoardMutationService,
      inject: [MysqlBoardAccessPolicy, DocumentCheckpointCodec],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        checkpointCodec: DocumentCheckpointCodec,
      ) => new BoardMutationService(accessPolicy, checkpointCodec),
    },
    {
      provide: HistoryListService,
      inject: [MysqlBoardAccessPolicy, HistoryCursorCodec, APP_ENVIRONMENT],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        cursors: HistoryCursorCodec,
        environment: AppEnvironment,
      ) =>
        new HistoryListService(accessPolicy, cursors, environment.historyRetainedEmissionEnabled),
    },
    {
      provide: HistoryGetService,
      inject: [
        MysqlBoardAccessPolicy,
        DocumentCheckpointCodec,
        SnapshotCompositionService,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        checkpointCodec: DocumentCheckpointCodec,
        snapshots: SnapshotCompositionService,
        environment: AppEnvironment,
      ) =>
        new HistoryGetService(
          accessPolicy,
          checkpointCodec,
          snapshots,
          environment.historyRetainedEmissionEnabled,
        ),
    },
  ],
  exports: [
    BoardCreateService,
    BoardArchiveService,
    BoardCapabilitiesService,
    BoardGetService,
    BoardListService,
    BoardRenameService,
    BoardMutationService,
    HistoryListService,
    HistoryGetService,
    SnapshotCompositionService,
    ArtifactsModule,
    InteractionsModule,
  ],
})
export class BoardModule {}
