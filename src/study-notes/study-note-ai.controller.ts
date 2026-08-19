import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import { NoteAiActionDto } from '../ai/dto/note-ai-action.dto';
import { NoteAiActionService } from '../ai/note-ai-action.service';
import { StudyNotesService } from './study-notes.service';

/**
 * 노트 AI 패널 — 공부 노트 쪽 진입점 (2026-08-19).
 *
 * `POST /study-notes/:id/ai-action`
 *
 * 컨트롤러가 하는 일은 **소유권 확인과 자원 태깅 두 가지뿐**이다. 변환·쿼터·과금은
 * 전부 `NoteAiActionService` 가 하고, 준비 노트 스텝 쪽 컨트롤러도 같은 서비스를 부른다
 * (엔드포인트 2개 · 서비스 1개).
 *
 * 🔴 노트가 없거나 남의 것이면 **404** 다 — 존재 여부를 알려 주지 않는다.
 */
@Controller('study-notes/:id/ai-action')
export class StudyNoteAiController {
  constructor(
    private readonly notes: StudyNotesService,
    private readonly noteAi: NoteAiActionService,
  ) {}

  @Post()
  async run(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NoteAiActionDto,
  ) {
    // 기존 상세 조회와 같은 판정 (없거나 타인 → NotFoundException)
    await this.notes.get(user.id, id);
    return this.noteAi.run(user.id, { type: 'study_note', id }, dto);
  }
}
