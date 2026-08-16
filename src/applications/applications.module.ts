import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { AiModule } from '../ai/ai.module';
import { CompaniesModule } from '../companies/companies.module';
import { InterviewPrepModule } from '../interview-prep/interview-prep.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { Application } from './application.entity';
import { User } from '../users/user.entity';
import { InterviewPrepSession } from '../interview-prep/entities/interview-prep-session.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { StepNoteSheet } from './step-note-sheet.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CoverletterChatMessage } from './coverletter-chat-message.entity';
import { Coverletter } from '../myinfo/entities/coverletter.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Award } from '../myinfo/entities/award.entity';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ApplicationCoverlettersController } from './application-coverletters.controller';
import { ApplicationCoverlettersService } from './application-coverletters.service';
import { CoverletterSourceRefsController } from './coverletter-source-refs.controller';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';
import { AiCoverletterController } from './ai-coverletter.controller';
import { AiCoverletterDraftService } from './ai-coverletter-draft.service';
import { AiCoverletterFeedbackService } from './ai-coverletter-feedback.service';
import { CoverletterDocController } from './coverletter-doc.controller';
import { CoverletterChatService } from './coverletter-chat.service';
import { CoverletterChatCleanupCron } from './coverletter-chat-cleanup.cron';
import { CoverletterGenerationStuckCron } from './coverletter-generation-stuck.cron';
import { JobPostingController } from './job-posting.controller';
import { JobPostingService } from './job-posting.service';
import { StepNoteSheetsController } from './step-note-sheets.controller';
import { StepNoteSheetsService } from './step-note-sheets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      ApplicationStep,
      StepChecklistItem,
      StepNoteSheet,
      ApplicationCoverletter,
      CoverletterSourceRef,
      CoverletterChatMessage,
      // myinfo coverletter — chat service 가 selectedMyinfoFieldKeys inject 용 IDOR-safe 조회
      Coverletter,
      CoverletterCustom,
      // myinfo 수상 — chat selectedAwardIds inject
      // 면접 유도 모달 판정 — 서비스가 아니라 **엔티티만** 등록해 레포를 직접 주입한다.
      // 🔴 모듈을 import 하면 전이 순환이 생긴다 (2026-08-08 CI E2E 210 전량 실패 전례).
      User,
      InterviewPrepSession,
      Award,
    ]),
    // ActivityModule TypeOrmModule (ActivityLog/Reflection repo) — IDOR batch + ref source 조회
    forwardRef(() => ActivityModule),
    // AiModule (LlmService + LlmCallLog repo) — ai-draft 가 LlmService.call + quota COUNT
    forwardRef(() => AiModule),
    // MyinfoModule — ai-draft 가 getSafeDumpForAi 사용 (PII 제거된 dump)
    forwardRef(() => MyinfoModule),
    // InterviewPrepModule — CoverletterDocController 가 CompanyResearchService 재사용 (application 단위)
    forwardRef(() => InterviewPrepModule),
    // W2 — ApplicationsService 가 응답에 domain inject (favicon 로딩)
    CompaniesModule,
  ],
  controllers: [
    ApplicationsController,
    ApplicationCoverlettersController,
    CoverletterSourceRefsController,
    AiCoverletterController,
    CoverletterDocController,
    JobPostingController,
    StepNoteSheetsController,
  ],
  providers: [
    ApplicationsService,
    ApplicationCoverlettersService,
    CoverletterSourceRefsService,
    AiCoverletterDraftService,
    AiCoverletterFeedbackService,
    CoverletterChatService,
    CoverletterChatCleanupCron,
    CoverletterGenerationStuckCron,
    JobPostingService,
    StepNoteSheetsService,
  ],
  // F5 hard delete 가드가 ActivityLog/Reflection 서비스에서
  // CoverletterSourceRef Repository 를 조회하므로 TypeOrmModule export 필요
  exports: [ApplicationsService, CoverletterSourceRefsService, TypeOrmModule],
})
export class ApplicationsModule {}
