import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CompanyResearchService } from './company-research.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { InterviewPrepAiService } from './interview-prep-ai.service';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

class UpdateUserNotesDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

/**
 * F6 PR 2 Phase 2 — 면접 준비 세션 endpoints.
 *
 * - GET    /interview-prep-sessions?applicationId=...    — application 별 세션 목록
 * - POST   /interview-prep-sessions                       — 새 세션 (자소서·로그 선택 + 생성 메타)
 * - GET    /interview-prep-sessions/:id                   — 세션 단건 (질문 트리는 별도)
 * - PATCH  /interview-prep-sessions/:id                   — round/interviewType/myMemo (autosave)
 * - DELETE /interview-prep-sessions/:id                   — hard delete (questions CASCADE)
 * - GET    /interview-prep-sessions/:id/questions         — 질문 트리 (recursive CTE)
 * - POST   /interview-prep-sessions/:id/generate          — AI 일괄 생성 (main 5~8 + 꼬리)
 */
@Controller('interview-prep-sessions')
@UseGuards(AuthGuard('jwt'))
export class InterviewPrepSessionsController {
  constructor(
    private readonly sessions: InterviewPrepSessionsService,
    private readonly questions: InterviewPrepQuestionsService,
    private readonly ai: InterviewPrepAiService,
    private readonly research: CompanyResearchService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: { id: string },
    @Query('applicationId', ParseUUIDPipe) applicationId: string,
  ) {
    return this.sessions.listByApplication(user.id, applicationId);
  }

  @Post()
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateSessionDto) {
    return this.sessions.create(user.id, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sessions.findOne(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessions.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sessions.remove(user.id, id);
  }

  @Get(':id/questions')
  listQuestions(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.questions.listTreeBySession(user.id, id);
  }

  /** Phase 4 — coverletter/log id 배열을 title·카테고리로 expand (사이드바 메타카드 표시) */
  @Get(':id/refs')
  listRefs(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sessions.getRefs(user.id, id);
  }

  @Post(':id/generate')
  generate(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.generateSession(user.id, id);
  }

  /**
   * Phase 4 단계 B — 회사 조사 캐시 조회 (LLM 호출 X).
   * 없으면 null → 프론트가 "🔍 회사 조사" 버튼 노출
   */
  @Get(':id/research')
  getResearch(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.research.getCachedForSession(user.id, id);
  }

  /** Phase 4 단계 B — 사용자 자유 메모 update (AI 정보와 분리) */
  @Patch(':id/user-notes')
  updateUserNotes(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserNotesDto,
  ) {
    return this.research.updateUserNotes(user.id, id, dto.notes ?? null);
  }
}
