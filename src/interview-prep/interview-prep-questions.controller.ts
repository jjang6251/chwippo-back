import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateFollowupDto } from './dto/create-followup.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { InterviewPrepAiService } from './interview-prep-ai.service';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';

/**
 * F6 PR 2 Phase 2 — 면접 질문 endpoints.
 *
 * - PATCH /interview-prep-questions/:id              — my_memo autosave
 * - POST  /interview-prep-questions/:id/followups    — AI 단일 꼬리질문 생성 (parent.depth 0|1 만 가능)
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

  @Post(':id/followups')
  createFollowup(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) parentId: string,
    @Body() dto: CreateFollowupDto,
  ) {
    return this.ai.generateFollowup(user.id, parentId, dto.hint);
  }
}
