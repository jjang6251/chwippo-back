import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityModule } from '../activity/activity.module';
import { AiModule } from '../ai/ai.module';
import { ApplicationsModule } from '../applications/applications.module';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { InterviewPrepAiService } from './interview-prep-ai.service';
import { InterviewPrepQuestionsController } from './interview-prep-questions.controller';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';
import { InterviewPrepSessionsController } from './interview-prep-sessions.controller';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

/**
 * F6 PR 2 Phase 2 — 면접 준비 모듈.
 *
 * **외부 의존**:
 * - ActivityModule (ActivityLog repo) — extra_log_ids IDOR batch 가드 + context 빌더
 * - AiModule (LlmService + QuotaCheckService) — AI 질문 생성 + quota 단일 진입점
 * - ApplicationsModule (Application + ApplicationCoverletter + CoverletterSourceRef repo) — IDOR + 컨텍스트 UNION
 *
 * **export**: TypeOrmModule (F5 hard delete 가드가 ActivityLog/Reflection 서비스에서
 * InterviewPrepSession/Question Repository 를 JSONB `@>` 검색)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([InterviewPrepSession, InterviewPrepQuestion]),
    forwardRef(() => ActivityModule),
    forwardRef(() => AiModule),
    forwardRef(() => ApplicationsModule),
  ],
  controllers: [
    InterviewPrepSessionsController,
    InterviewPrepQuestionsController,
  ],
  providers: [
    InterviewPrepSessionsService,
    InterviewPrepQuestionsService,
    InterviewPrepAiService,
  ],
  exports: [
    TypeOrmModule,
    InterviewPrepSessionsService,
    InterviewPrepQuestionsService,
    InterviewPrepAiService,
  ],
})
export class InterviewPrepModule {}
