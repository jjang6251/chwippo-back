import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { AdminModule } from '../admin/admin.module';
import { AlertHistory } from '../admin/entities/alert-history.entity';
import { DiscordNotifier } from '../common/discord-notifier';
import { User } from '../users/user.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';
import { TierConfig } from './entities/tier-config.entity';
import { FeatureCoinMeta } from './entities/feature-coin-meta.entity';
import { UserCoinBalance } from './entities/user-coin-balance.entity';
import { UserPlanHistory } from './entities/user-plan-history.entity';
import { CoinService } from './coin.service';
import { UserCoinService } from './user-coin.service';
import { CoinResetCron } from './coin-reset.cron';
import { MyCoinController } from './my-coin.controller';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import { NoteSummaryService } from './note-summary.service';
import { AdminAiUsageService } from './admin-ai-usage.service';
import { AdminAiUsageController } from './admin-ai-usage.controller';
import { AdminFeatureQuotasController } from './admin-feature-quotas.controller';
import { AdminFeatureQuotasService } from './admin-feature-quotas.service';
import { MyAiQuotasController } from './my-ai-quotas.controller';
import { AbuserBanService } from './abuser-ban.service';
import { CostGuardService } from './cost-guard.service';
import { AlertThresholds } from '../admin/entities/alert-thresholds.entity';
import { AdminQuotaResetController } from './admin-quota-reset.controller';
import { AdminQuotaResetService } from './admin-quota-reset.service';
import { QuotaCheckService } from './quota-check.service';
import { openaiClientProvider } from './openai-client.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

@Module({
  imports: [
    // User: LlmService 가 consent gate + 본인 이름 블랙리스트 조회
    // UserAiQuota: PR 1 AbuserBanService 가 daily_cap_override UPSERT
    // FeatureQuotaConfig: PR 2 QuotaCheckService 가 feature 별·tier 별 한도 조회 (admin 동적 조절)
    TypeOrmModule.forFeature([
      LlmCallLog,
      User,
      UserAiQuota,
      FeatureQuotaConfig,
      // 5.6.3 — abuser-ban 이 alert_history 에 통합 row insert
      AlertHistory,
      // PR_B1 — 코인 시스템
      TierConfig,
      FeatureCoinMeta,
      UserCoinBalance,
      UserPlanHistory,
      // AI cost guard
      AlertThresholds,
    ]),
    forwardRef(() => ActivityModule),
    // AdminModule: AbuserBanService 가 AdminAuditService.log('auto_ban_ai', ...) 호출
    forwardRef(() => AdminModule),
  ],
  controllers: [
    AdminAiUsageController,
    AdminFeatureQuotasController,
    AdminQuotaResetController,
    MyAiQuotasController,
    MyCoinController, // PR_B1
  ],
  providers: [
    openaiClientProvider, // ModerationService 가 사용 (moderations API)
    OpenAIProvider,
    AnthropicProvider,
    LlmService,
    ModerationService,
    NoteSummaryService,
    AdminAiUsageService,
    AdminFeatureQuotasService,
    AbuserBanService,
    AdminQuotaResetService,
    QuotaCheckService,
    CostGuardService, // AI cost guard — per-user/per-feature daily USD cap
    CoinService, // PR_B1
    UserCoinService, // PR_B1
    CoinResetCron, // PR_B1
    DiscordNotifier,
  ],
  exports: [
    LlmService,
    ModerationService,
    NoteSummaryService,
    AbuserBanService, // ApplicationsModule(ai-coverletter-draft) 에서 quota override 통합
    QuotaCheckService, // PR 2 — 모든 LLM caller 가 호출하는 단일 quota 진입점
    CostGuardService, // 모든 LLM caller 가 호출 가능 (선택적 — cost cap 강화 시)
    CoinService, // PR_B1 — admin·결제 module 에서 차감·tier 변경 호출
    UserCoinService, // PR_B1 — admin tier 변경 + history
    DiscordNotifier, // PR 2 Phase 5.4 — alert threshold cron 에서 공유
    TypeOrmModule,
  ],
})
export class AiModule {}
