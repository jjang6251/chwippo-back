import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiCoverletterDraftService } from './ai-coverletter-draft.service';
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
  constructor(private readonly service: AiCoverletterDraftService) {}

  @Post('ai-draft')
  generate(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
    @Body() dto: GenerateAiDraftDto,
  ) {
    return this.service.generate(user.id, clId, dto);
  }
}
