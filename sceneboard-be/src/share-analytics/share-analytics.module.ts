import { Module } from '@nestjs/common';

import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { MysqlService } from '../database/mysql.service.js';
import { PublicShareProjectionRepository } from '../shares/public-share-projection.repository.js';
import { PublicShareResolver } from '../shares/public-share.resolver.js';
import { ShareCookieService } from '../shares/share-cookie.service.js';
import { ShareModule } from '../shares/share.module.js';
import { ShareAnalyticsContextService } from './context/share-analytics-context.service.js';
import { ShareAnalyticsEventService } from './event/share-analytics-event.service.js';
import { ShareAnalyticsReportService } from './report/share-analytics-report.service.js';
import { ShareAnalyticsRetentionService } from './retention/share-analytics-retention.service.js';
import { ShareAnalyticsController } from './share-analytics.controller.js';

@Module({
  imports: [ShareModule],
  controllers: [ShareAnalyticsController],
  providers: [
    {
      provide: 'SHARE_ANALYTICS_BROWSER_ORIGIN',
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => environment.browserOrigin,
    },
    {
      provide: ShareAnalyticsContextService,
      inject: [
        CryptoService,
        PublicShareResolver,
        PublicShareProjectionRepository,
        ShareCookieService,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        crypto: CryptoService,
        resolver: PublicShareResolver,
        projections: PublicShareProjectionRepository,
        shareCookies: ShareCookieService,
        environment: AppEnvironment,
      ) =>
        new ShareAnalyticsContextService(
          crypto,
          resolver,
          projections,
          shareCookies,
          new URL(environment.browserOrigin).hostname,
        ),
    },
    {
      provide: ShareAnalyticsEventService,
      inject: [MysqlService, CryptoService],
      useFactory: (mysql: MysqlService, crypto: CryptoService) =>
        new ShareAnalyticsEventService(mysql, crypto),
    },
    {
      provide: ShareAnalyticsReportService,
      inject: [MysqlService],
      useFactory: (mysql: MysqlService) => new ShareAnalyticsReportService(mysql),
    },
    {
      provide: ShareAnalyticsRetentionService,
      inject: [MysqlService],
      useFactory: (mysql: MysqlService) => new ShareAnalyticsRetentionService(mysql),
    },
  ],
  exports: [ShareAnalyticsRetentionService],
})
export class ShareAnalyticsModule {}
