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
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { InterviewPrepAiService } from './interview-prep-ai.service';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

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

  @Post(':id/generate')
  generate(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.generateSession(user.id, id);
  }
}
