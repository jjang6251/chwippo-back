import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import { NoteSummaryService } from './note-summary.service';
import { AdminAiUsageService } from './admin-ai-usage.service';
import { AdminAiUsageController } from './admin-ai-usage.controller';
import { openaiClientProvider } from './openai-client.provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([LlmCallLog]),
    forwardRef(() => ActivityModule),
  ],
  controllers: [AdminAiUsageController],
  providers: [
    openaiClientProvider,
    LlmService,
    ModerationService,
    NoteSummaryService,
    AdminAiUsageService,
  ],
  exports: [LlmService, ModerationService, NoteSummaryService, TypeOrmModule],
})
export class AiModule {}
