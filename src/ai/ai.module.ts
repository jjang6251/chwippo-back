import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { AdminModule } from '../admin/admin.module';
import { User } from '../users/user.entity';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import { NoteSummaryService } from './note-summary.service';
import { AdminAiUsageService } from './admin-ai-usage.service';
import { AdminAiUsageController } from './admin-ai-usage.controller';
import { AdminFeatureQuotasController } from './admin-feature-quotas.controller';
import { AdminFeatureQuotasService } from './admin-feature-quotas.service';
import { MyAiQuotasController } from './my-ai-quotas.controller';
import { AbuserBanService } from './abuser-ban.service';
import { QuotaCheckService } from './quota-check.service';
import { openaiClientProvider } from './openai-client.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

@Module({
  imports: [
    // User: LlmService 가 consent gate + 본인 이름 블랙리스트 조회
    // UserAiQuota: PR 1 AbuserBanService 가 daily_cap_override UPSERT
    // FeatureQuotaConfig: PR 2 QuotaCheckService 가 feature 별·tier 별 한도 조회 (admin 동적 조절)
    TypeOrmModule.forFeature([LlmCallLog, User, UserAiQuota, FeatureQuotaConfig]),
    forwardRef(() => ActivityModule),
    // AdminModule: AbuserBanService 가 AdminAuditService.log('auto_ban_ai', ...) 호출
    forwardRef(() => AdminModule),
  ],
  controllers: [
    AdminAiUsageController,
    AdminFeatureQuotasController,
    MyAiQuotasController,
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
    QuotaCheckService,
  ],
  exports: [
    LlmService,
    ModerationService,
    NoteSummaryService,
    AbuserBanService, // ApplicationsModule(ai-coverletter-draft) 에서 quota override 통합
    QuotaCheckService, // PR 2 — 모든 LLM caller 가 호출하는 단일 quota 진입점
    TypeOrmModule,
  ],
})
export class AiModule {}
