import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { AiModule } from '../ai/ai.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ApplicationCoverlettersController } from './application-coverletters.controller';
import { ApplicationCoverlettersService } from './application-coverletters.service';
import { CoverletterSourceRefsController } from './coverletter-source-refs.controller';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';
import { AiCoverletterController } from './ai-coverletter.controller';
import { AiCoverletterDraftService } from './ai-coverletter-draft.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      ApplicationStep,
      StepChecklistItem,
      ApplicationCoverletter,
      CoverletterSourceRef,
    ]),
    // ActivityModule TypeOrmModule (ActivityLog/Reflection repo) — IDOR batch + ref source 조회
    forwardRef(() => ActivityModule),
    // AiModule (LlmService + LlmCallLog repo) — ai-draft 가 LlmService.call + quota COUNT
    forwardRef(() => AiModule),
    // MyinfoModule — ai-draft 가 getSafeDumpForAi 사용 (PII 제거된 dump)
    forwardRef(() => MyinfoModule),
  ],
  controllers: [
    ApplicationsController,
    ApplicationCoverlettersController,
    CoverletterSourceRefsController,
    AiCoverletterController,
  ],
  providers: [
    ApplicationsService,
    ApplicationCoverlettersService,
    CoverletterSourceRefsService,
    AiCoverletterDraftService,
  ],
  // F5 hard delete 가드가 ActivityLog/Reflection 서비스에서
  // CoverletterSourceRef Repository 를 조회하므로 TypeOrmModule export 필요
  exports: [ApplicationsService, CoverletterSourceRefsService, TypeOrmModule],
})
export class ApplicationsModule {}
