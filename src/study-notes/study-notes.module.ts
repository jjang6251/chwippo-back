import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { FilesModule } from '../files/files.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { NoteAttachment } from './note-attachment.entity';
import { NoteAttachmentsService } from './note-attachments.service';
import { StudyNoteFolder } from './study-note-folder.entity';
import { StudyNoteLink } from './study-note-link.entity';
import { StudyNote } from './study-note.entity';
import { StudyNoteAiController } from './study-note-ai.controller';
import { StudyNoteFoldersService } from './study-note-folders.service';
import { StudyNotesController } from './study-notes.controller';
import { StudyNotesService } from './study-notes.service';

/**
 * 공부 노트 모듈.
 *
 * ## 🔴 import 규칙 — "돌아올 경로가 없는" 모듈만 끌어온다
 *
 * 금지된 건 import 자체가 아니라 **순환**이다 (2026-08-08 CI E2E 210 전량 실패 전례).
 * 판정은 "저쪽이 언젠가 이쪽을 필요로 할 수 있나" 하나로 한다.
 *
 * | 대상 | 판정 |
 * |---|---|
 * | `ApplicationsModule` | ❌ **끌어오지 않는다.** 허브의 「회사 준비」는 applications·steps·step_note_sheets 를 읽지만 raw SQL 이라 엔티티 등록도 필요 없다. 게다가 저쪽(시트 저장)이 이쪽 링크를 재계산하므로 import 하면 곧바로 양방향이 된다 |
 * | `DashboardModule` | ✅ **끌어온다.** streak 캐시 무효화용. 대시보드는 통계를 읽기만 하고 공부 노트를 필요로 할 일이 없어 돌아올 간선이 없다. `ActivityModule` 이 같은 이유로 쓰는 그대로다 |
 * | `AiModule` | ✅ **끌어온다 (forwardRef 없이).** 노트 AI 패널이 `NoteAiActionService` 를 쓴다. AiModule 은 `ActivityModule`·`AdminModule` 을 forwardRef 로 갖고 있지만, 그 어느 쪽도 공부 노트를 import 하지 않는다 — 이 모듈을 import 하는 곳은 `app.module` 하나뿐이라 **돌아올 간선 자체가 없다.** (판정 근거는 실측이고, 앱 부팅 자체를 e2e 가 잠근다) |
 * | `FilesModule` | ✅ **끌어온다.** 첨부 등록의 `assertOwnFileUrl`·R2 삭제. import 가 **하나도 없는 잎 모듈**이라 돌아올 간선이 원리적으로 없다 |
 * | `MyinfoModule` | ✅ **끌어온다.** 100MB 용량 cap 의 단일 소스가 `StorageUsageService` 다 — 여기서 따로 세면 두 도메인이 서로의 사용량을 못 봐 합이 한도를 넘는다. 저쪽 import 는 `TypeOrmModule.forFeature` 와 `FilesModule` 둘뿐이라(실측) 돌아올 간선이 없다 |
 *
 * 준비 노트 시트 저장 경로가 이 도메인의 링크를 재계산할 때도 서비스를 주입하지 않는다 —
 * `mention-links.ts` 가 `EntityManager` 를 인자로 받는 **순수 함수**라 DI 간선이 안 생긴다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudyNote,
      StudyNoteFolder,
      StudyNoteLink,
      NoteAttachment,
    ]),
    // streak 소스 +1 (study_notes.updated_at) — 저장 즉시 반영하려면 캐시를 비워야 한다
    DashboardModule,
    // 노트 AI 패널 — NoteAiActionService (전이 순환 없음, 위 표 참조)
    AiModule,
    // 본문 이미지 — 파일 소유권·R2 삭제 (FilesService)
    FilesModule,
    // 본문 이미지 — 100MB cap 합산 (StorageUsageService)
    MyinfoModule,
  ],
  controllers: [StudyNotesController, StudyNoteAiController],
  providers: [
    StudyNotesService,
    StudyNoteFoldersService,
    NoteAttachmentsService,
  ],
})
export class StudyNotesModule {}
