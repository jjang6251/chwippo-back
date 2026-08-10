import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateFollowupDto } from './dto/create-followup.dto';
import { PracticeQuestionDto } from './dto/practice-question.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { InterviewPrepAiService } from './interview-prep-ai.service';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';

/**
 * F6 PR 2 Phase 2 — 면접 질문 endpoints.
 *
 * - PATCH  /interview-prep-questions/:id              — my_memo autosave + (내 질문만) 본문·카테고리 수정
 * - DELETE /interview-prep-questions/:id              — 질문 삭제 (AI·내 질문 모두 · 자손 CASCADE)
 * - POST   /interview-prep-questions/:id/practice     — 「면접 보기」 자가평가 저장
 * - POST   /interview-prep-questions/:id/answer       — AI 예상 답변 1개 생성 (v2)
 * - POST   /interview-prep-questions/:id/regenerate   — ↻ 낱개 교체 (AI depth-0 만)
 * - POST   /interview-prep-questions/:id/followups    — AI 단일 꼬리질문 생성 (parent.depth 0|1 만 가능)
 */
@Controller('interview-prep-questions')
@UseGuards(AuthGuard('jwt'))
export class InterviewPrepQuestionsController {
  constructor(
    private readonly questions: InterviewPrepQuestionsService,
    private readonly ai: InterviewPrepAiService,
  ) {}

  @Patch(':id')
  update(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.questions.update(user.id, id, dto);
  }

  /**
   * 질문 삭제 — 내용 유무 확인(「답변과 꼬리 N개가 함께 삭제돼요」)은 **프론트 몫**이다.
   * 서버까지 확인 플래그를 요구하면 같은 판단이 두 곳에 생긴다.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.questions.remove(user.id, id);
  }

  /**
   * 「면접 보기」 자가평가 — reveal 직후 잘함/애매/다시.
   * 연습 중 즉시 호출되므로 **가볍게 유지한다** (LLM·집계 없음).
   */
  @Post(':id/practice')
  practice(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PracticeQuestionDto,
  ) {
    return this.questions.recordPractice(user.id, id, dto.result);
  }

  /**
   * v2 — 사용자가 그 질문에서 `AI 도움` 을 눌렀을 때. body 없음 (질문 id 만으로 충분).
   * 이미 답변이 있으면 재생성해 덮어쓴다.
   */
  @Post(':id/answer')
  generateAnswer(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.generateAnswer(user.id, id);
  }

  /**
   * ↻ 낱개 교체 — 이 질문 하나를 같은 자리에서 새 AI 질문으로 바꾼다. body 없음.
   *
   * 🔴 **답변·꼬리가 함께 사라지는 유일한 경로다.** "N개가 함께 삭제돼요" 확인은
   * 프론트 몫이다 — 서버까지 확인 플래그를 요구하면 같은 판단이 두 곳에 생긴다
   * (DELETE 와 같은 규칙).
   */
  @Post(':id/regenerate')
  regenerate(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.regenerateQuestion(user.id, id);
  }

  @Post(':id/followups')
  createFollowup(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) parentId: string,
    @Body() dto: CreateFollowupDto,
  ) {
    return this.ai.generateFollowup(user.id, parentId, dto.hint);
  }
}
