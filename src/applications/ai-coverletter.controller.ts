import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiCoverletterDraftService } from './ai-coverletter-draft.service';
import { AiCoverletterFeedbackService } from './ai-coverletter-feedback.service';
import { GenerateAiDraftDto } from './dto/ai-draft.dto';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * F6 PR 1 — AI 자소서 답변 생성 endpoint.
 * Phase 2D: ai-draft (POST /coverletters/:clId/ai-draft).
 * Phase 후속 (PR 1 의 다른 부분 또는 PR 2): ai-feedback (POST /coverletters/:clId/ai-feedback) 등 — 같은 controller 에 추가.
 */
@Controller('coverletters/:clId')
export class AiCoverletterController {
  constructor(
    private readonly service: AiCoverletterDraftService,
    private readonly feedbackService: AiCoverletterFeedbackService,
  ) {}

  @Post('ai-draft')
  generate(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
    @Body() dto: GenerateAiDraftDto,
  ) {
    return this.service.generate(user.id, clId, dto);
  }

  /** A1 Phase 2 — AI 제출 전 점검 (짚어주기). body 없음 — 대상은 저장된 답변 */
  @Post('ai-feedback')
  review(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
  ) {
    return this.feedbackService.review(user.id, clId);
  }
}
