import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLog } from './admin-audit-log.entity';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';
import { AlertThresholdsController } from './alert-thresholds.controller';
import { AlertThresholdsService } from './alert-thresholds.service';
import { ProviderHealthCron } from './provider-health.cron';
import { ProviderHealthService } from './provider-health.service';
import { SystemStatusController } from './system-status.controller';
import { ThresholdCheckService } from './threshold-check.service';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { TierConfigAdminController } from './tier-config-admin.controller';
import { TierConfigAdminService } from './tier-config-admin.service';
import { TierConfig } from '../ai/entities/tier-config.entity';
import { FeatureCoinMetaAdminController } from './feature-coin-meta-admin.controller';
import { FeatureCoinMetaAdminService } from './feature-coin-meta-admin.service';
import { FeatureCoinMeta } from '../ai/entities/feature-coin-meta.entity';
import { AdminInquiriesController } from './admin-inquiries.controller';
import { AdminInquiriesService } from './admin-inquiries.service';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminNotificationsController } from './admin-notifications.controller';
import { CompanyResearchMetricsController } from './company-research-metrics.controller';
import { CompanyResearchMetricsService } from './company-research-metrics.service';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { AiModule } from '../ai/ai.module';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { UsersModule } from '../users/users.module';
import { InquiriesModule } from '../inquiries/inquiries.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { Cert } from '../myinfo/entities/cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Document } from '../myinfo/entities/document.entity';
import { Education } from '../myinfo/entities/education.entity';
import { UserCoinBalance } from '../ai/entities/user-coin-balance.entity';
import { UnsuspendCron } from '../users/unsuspend.cron';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminAuditLog,
      AlertThresholds,
      AlertHistory,
      LlmCallLog,
      User,
      UserCoinBalance,
      TierConfig,
      FeatureCoinMeta,
      Inquiry,
      CompanyResearchCache,
      Application,
      Cert,
      Award,
      LanguageCert,
      Experience,
      CoverletterCustom,
      Document,
      Education,
    ]),
    UsersModule,
    InquiriesModule,
    MyinfoModule,
    // F6 PR 2 Phase 5.4 — DiscordNotifier 공유 (abuser-ban 과 같은 webhook URL)
    forwardRef(() => AiModule),
  ],
  controllers: [
    AdminController,
    AdminUsersController,
    AlertThresholdsController,
    SystemStatusController,
    AiUsageController, // PR_B2 Phase 2
    TierConfigAdminController, // PR_B2 Phase 3
    FeatureCoinMetaAdminController, // PR_B2 Phase 3
    AdminInquiriesController, // PR_B2 Phase 4
    AdminAuditLogsController, // PR_B2 Phase 4
    AdminNotificationsController, // PR_B2 Phase 4
    CompanyResearchMetricsController, // PR_B2 Phase 4
  ],
  providers: [
    AdminService,
    AdminUsersService,
    AdminAuditService,
    AlertThresholdsService,
    ThresholdCheckService,
    ProviderHealthService,
    ProviderHealthCron,
    UnsuspendCron, // PR_B2 Phase 1
    AiUsageService, // PR_B2 Phase 2
    TierConfigAdminService, // PR_B2 Phase 3
    FeatureCoinMetaAdminService, // PR_B2 Phase 3
    AdminInquiriesService, // PR_B2 Phase 4
    AdminAuditLogsService, // PR_B2 Phase 4
    CompanyResearchMetricsService, // PR_B2 Phase 4
  ],
  exports: [
    AdminAuditService,
    AlertThresholdsService,
    ThresholdCheckService,
    AiUsageService,
  ],
})
export class AdminModule {}
