import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { FilesService } from '../files/files.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { extractAttachmentIds } from './attachment-refs';
import { CreateNoteAttachmentDto } from './dto/note-attachment.dto';
import { NoteAttachment } from './note-attachment.entity';
import { StudyNote } from './study-note.entity';

export interface RegisteredAttachment {
  id: string;
  fileUrl: string;
}

/**
 * 등록 직후 **유예 창** — 이보다 어린 행은 "본문 미참조" 여도 고아로 안 본다.
 *
 * 자동저장(1.5초 디바운스)이 이미지 등록보다 먼저 날아가는 인터리빙 때문이다
 * (자세한 건 `reconcile` docblock). 60초는 "등록 왕복 + 노드 확정" 이 끝나고도
 * 한참 남는 폭이면서, 끝내 확정 안 된 진짜 고아가 다음 저장 한 번이면 정리되는 선이다.
 */
export const NEW_ATTACHMENT_GRACE_SECONDS = 60;

/**
 * **공부 노트 첨부** — 등록 · 저장 시 정리(reconcile) · 노트 삭제 시 수집.
 *
 * ## 파일은 두 곳에 산다 — DB 행과 R2 객체
 *
 * 둘의 정합을 지키는 규칙 하나: **DB 는 트랜잭션 안에서, R2 는 커밋 뒤 best-effort.**
 * 반대로 하면(먼저 R2 삭제 → 트랜잭션 롤백) 행은 살아 있는데 그림만 사라진 노트가 된다 —
 * 사용자가 되돌릴 방법이 없다. 반대 방향의 사고(행은 지웠는데 R2 삭제 실패)는 고아 객체가
 * 남을 뿐이고, R2 무료 한도 안에서 무해하다. 그래서 정리 메서드들은 **지울 URL 목록을
 * 돌려주고**, 호출자가 커밋 뒤에 `cleanupFiles` 로 흘려보낸다 (myinfo `updateWithFileSwap` 규약).
 *
 * ## 등록은 왜 한 트랜잭션인가
 *
 * 소유권 → cap → insert 가 갈라지면 두 요청이 각자 "아직 여유 있음" 을 보고 통과해 합이
 * 한도를 넘는다. `SELECT ... FOR UPDATE` 로 사용자 행을 잡아 같은 사용자의 등록을 줄 세운다
 * (myinfo 파일 교체와 같은 락 규약이라 두 경로가 서로의 여유분도 본다).
 */
@Injectable()
export class NoteAttachmentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly filesService: FilesService,
    private readonly storageUsage: StorageUsageService,
  ) {}

  /**
   * R2 PUT 성공 후 등록. 응답은 `{ id, fileUrl }` — 프론트가 `id` 를 이미지 노드 attrs 에
   * 박고, 그 값이 다음 저장의 reconcile 기준이 된다.
   *
   * 🔴 **멱등** — 같은 `fileUrl` 로 다시 부르면 기존 행을 그대로 돌려준다 (용량도 다시 안
   * 청구한다). R2 PUT 은 성공했는데 등록 응답을 못 받은 프론트가 재시도하는 경로가 실재하고,
   * 그때마다 행이 늘면 사용자는 올린 적 없는 용량을 쓴다. 판정이 락 **안**이라 동시 재시도도
   * 여기서 갈린다 (그래서 `unique(file_url)` 위반이 실사용 경로로 도달하지 않는다).
   */
  async register(
    userId: string,
    noteId: string,
    dto: CreateNoteAttachmentDto,
  ): Promise<RegisteredAttachment> {
    return this.dataSource.transaction(async (em) => {
      // 소유권 — 남의 노트에 붙이려는 시도는 **404** (존재 여부를 알려 주지 않는다)
      const note = await em
        .getRepository(StudyNote)
        .findOne({ where: { id: noteId, userId } });
      if (!note) throw new NotFoundException('노트를 찾을 수 없습니다.');

      // 남이 올린 파일 URL 을 내 노트에 붙이는 쓰기 IDOR 차단 → 403
      this.filesService.assertOwnFileUrl(userId, dto.fileUrl);

      // cap 판정 전에 잠근다 — 동시 등록이 각자 여유를 보고 통과하면 합이 한도를 넘는다
      await em.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      const repo = em.getRepository(NoteAttachment);
      const existing = await repo.findOne({
        where: { fileUrl: dto.fileUrl, userId },
      });
      if (existing) return { id: existing.id, fileUrl: existing.fileUrl };

      // 초과 시 숫자를 실은 400 (`저장 공간이 부족합니다 (현재 NMB / 100MB).`)
      await this.storageUsage.assertWithinLimit(userId, dto.fileSizeBytes, em);

      const row = await repo.save(
        repo.create({
          userId,
          noteId,
          kind: 'image',
          fileUrl: dto.fileUrl,
          fileSizeBytes: dto.fileSizeBytes,
          strokesUrl: null,
          strokesSizeBytes: null,
        }),
      );
      return { id: row.id, fileUrl: row.fileUrl };
    });
  }

  /**
   * 저장 시 정리 — 본문이 더 이상 가리키지 않는 첨부 행을 지우고, **지운 R2 URL 을 돌려준다.**
   *
   * 🔴 반드시 **저장과 같은 트랜잭션의 `EntityManager`** 를 받는다. 저장은 롤백됐는데 행만
   * 지워지면 본문은 이미지를 가리키는데 첨부는 없는 상태가 된다.
   *
   * 🔴 본문을 **못 읽으면 아무것도 안 지운다.** 깨진 JSON 을 "참조 0개" 로 뭉개면 그 한 번의
   * 저장이 노트의 이미지를 전부 날린다 (`attachment-refs.ts` 의 `null` 계약).
   * 반대로 정상적으로 읽은 빈 본문은 **정말 참조가 0개**라 전부 정리한다 — 이미지를 다 지운
   * 사용자의 용량이 안 돌아오면 그것대로 새는 것이다.
   *
   * 두 탭이 같은 노트를 저장하면 저장 자체가 last-write-wins 이므로, 진 탭이 방금 넣은
   * 이미지는 이긴 탭의 본문에 없어 여기서 정리된다 — 본문 정책과 같은 결말이다.
   *
   * ## 🔴 등록 직후 60초는 건드리지 않는다 (race)
   *
   * 이미지를 붙여넣으면 프론트는 placeholder 를 먼저 꽂고, 그게 자동저장(1.5초 디바운스)을
   * 깨운다. 그래서 **`attachmentId` 가 아직 없는 본문**이 등록 요청을 앞질러 저장되는
   * 인터리빙이 실재한다 — 그 저장의 reconcile 이 방금 커밋된 행을 "미참조" 로 보고 지우면,
   * 잠시 뒤 노드에 박히는 id 는 이미 죽은 행을 가리켜 이미지가 깨진다 (사용자는 복구 불가).
   * 그래서 **`created_at` 이 유예 창 안인 행은 고아 판정에서 뺀다.** 미확정 신규 첨부는
   * 다음 저장(그때는 본문에 id 가 있다)이 지켜 주고, 끝내 확정 안 된 진짜 고아는 60초가
   * 지난 뒤의 저장에서 정리된다 — 기존 best-effort 정책과 같은 결이다.
   *
   * 🔴 시계는 **DB 것**을 쓴다 (`now() - interval`). 앱 시계로 비교하면 서버·DB 시차와
   * TZ 설정에 따라 유예 창이 늘었다 줄었다 하고, 그 어긋남은 재현이 안 되는 형태로 나타난다.
   */
  async reconcile(
    em: EntityManager,
    noteId: string,
    content: string | null,
  ): Promise<string[]> {
    const referenced = extractAttachmentIds(content);
    if (referenced === null) return [];

    const repo = em.getRepository(NoteAttachment);
    const rows = await repo
      .createQueryBuilder('a')
      .select(['a.id', 'a.fileUrl', 'a.strokesUrl'])
      .where('a.noteId = :noteId', { noteId })
      .andWhere(
        `a.createdAt < now() - interval '${NEW_ATTACHMENT_GRACE_SECONDS} seconds'`,
      )
      .getMany();

    const keep = new Set(referenced);
    const orphans = rows.filter((row) => !keep.has(row.id));
    if (orphans.length === 0) return [];

    await repo.delete({ id: In(orphans.map((row) => row.id)) });
    return orphans.flatMap((row) =>
      row.strokesUrl ? [row.fileUrl, row.strokesUrl] : [row.fileUrl],
    );
  }

  /**
   * 노트 삭제 **전에** URL 을 모은다. 행은 FK CASCADE 가 지우지만, 지운 뒤엔 무엇을
   * 지워야 하는지 알 방법이 없다 — 그래서 순서가 뒤집히면 R2 에 고아만 남는다.
   */
  async collectFileUrls(em: EntityManager, noteId: string): Promise<string[]> {
    const rows = await em.getRepository(NoteAttachment).find({
      where: { noteId },
      select: { fileUrl: true, strokesUrl: true },
    });
    return rows.flatMap((row) =>
      row.strokesUrl ? [row.fileUrl, row.strokesUrl] : [row.fileUrl],
    );
  }

  /**
   * 커밋 뒤 R2 정리 — **best-effort**. `deleteFile` 이 실패를 삼키므로(고아 객체는 무해)
   * 이 호출이 사용자 흐름을 되돌리는 일은 없다.
   */
  async cleanupFiles(fileUrls: string[]): Promise<void> {
    for (const url of fileUrls) {
      await this.filesService.deleteFile(url);
    }
  }
}
