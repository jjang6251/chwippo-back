import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import { NoteAiActionDto } from '../ai/dto/note-ai-action.dto';
import { NoteAiActionService } from '../ai/note-ai-action.service';
import { StepNoteSheetsService } from './step-note-sheets.service';

/**
 * 노트 AI 패널 — 준비 노트(스텝) 쪽 진입점 (2026-08-19).
 *
 * `POST /applications/:id/steps/:stepId/ai-action`
 *
 * 시트 CRUD 와 같은 프리픽스를 쓴다 — 소유권 체인(step → application → user)이
 * URL 에 그대로 드러나야 컨트롤러가 3-hop 을 빠짐없이 검증한다. 어긋나면 전부 404.
 *
 * 🔴 자원 태깅은 **스텝 id** 다 (시트 id 가 아니다). 패널은 스텝 단위로 열리고,
 * 어느 시트 탭에서 눌렀는지는 결과에 영향을 주지 않는다.
 */
@Controller('applications/:id/steps/:stepId/ai-action')
export class StepAiActionController {
  constructor(
    private readonly sheets: StepNoteSheetsService,
    private readonly noteAi: NoteAiActionService,
  ) {}

  @Post()
  async run(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: NoteAiActionDto,
  ) {
    await this.sheets.assertOwnsStep(user.id, id, stepId);
    return this.noteAi.run(
      user.id,
      { type: 'application_step', id: stepId },
      dto,
    );
  }
}
