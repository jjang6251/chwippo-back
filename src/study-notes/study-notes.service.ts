import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StreakService } from '../dashboard/streak.service';
import { CreateStudyNoteDto, UpdateStudyNoteDto } from './dto/study-note.dto';
import { syncStudyNoteLinks } from './mention-links';
import { NoteAttachmentsService } from './note-attachments.service';
import { StudyNoteFolder } from './study-note-folder.entity';
import { StudyNoteLink } from './study-note-link.entity';
import { StudyNote } from './study-note.entity';

/**
 * 사용자당 노트 상한 (CEO 결정 — UX 최종 검토 ④). 폴더 캡과 같은 abuse 방지선이고,
 * 숫자를 문구에 실어 400 으로 되돌린다.
 */
export const MAX_NOTES_PER_USER = 500;

/** 제목 — **trim 후** 판정. 0자(빈 제목)는 **정상 값** */
export const NOTE_TITLE_MAX_CHARS = 100;

/**
 * 제목 정규화 + 길이 판정의 단일 지점.
 *
 * 폴더·시트 이름과 달리 **하한이 없다**. 생성이 노션식이라 (버튼 → 빈 노트 → 에디터)
 * 제목 없는 노트가 정상 상태다. 화면에 「제목 없음」을 보여 주는 건 프론트 몫이고,
 * 서버가 그 문자열을 대신 저장하면 사용자가 지울 수 없는 제목이 박힌다.
 */
function normalizeTitle(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length > NOTE_TITLE_MAX_CHARS) {
    throw new BadRequestException(
      `제목은 공백을 뺀 ${NOTE_TITLE_MAX_CHARS}자까지 입력할 수 있어요.`,
    );
  }
  return trimmed;
}

/** 허브 목록 한 줄 — **본문은 싣지 않는다** */
export interface StudyNoteListItem {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: Date;
  /**
   * 이 노트를 가리키는 문서 수.
   *
   * 🔴 `GET /study-notes/:id/backlinks` 가 **실제로 돌려줄 줄 수**와 같은 기준으로 센다.
   * 배지가 3인데 패널을 열면 2줄이면 사용자는 어느 쪽이 거짓말인지 알 수 없다.
   */
  backlinkCount: number;
}

/** 백링크 한 줄 — "이 노트를 어디서 참조했나" */
export interface BacklinkItem {
  fromType: 'study' | 'prep_sheet';
  /** 공부 노트 id 또는 준비 노트 시트 id */
  fromId: string;
  /** 화면 라벨. study = 노트 제목(빈 제목이면 '') · prep_sheet = "회사명 — 스텝명" */
  label: string;
  /** prep_sheet 딥링크용. study 는 둘 다 null */
  applicationId: string | null;
  stepId: string | null;
}

/** 허브의 「회사 준비」 행 — 카드-스텝 묶음 하나 */
export interface PrepHubGroup {
  applicationId: string;
  companyName: string;
  stepId: string;
  stepName: string;
  sheetCount: number;
  lastUpdatedAt: Date;
}

interface BacklinkRow {
  from_type: 'study' | 'prep_sheet';
  from_id: string;
  title: string | null;
  company_name: string | null;
  step_name: string | null;
  application_id: string | null;
  step_id: string | null;
}

interface StudyNoteListRow {
  id: string;
  title: string;
  folder_id: string | null;
  updated_at: Date;
  backlink_count: number;
}

interface PrepHubRow {
  application_id: string;
  company_name: string;
  step_id: string;
  step_name: string;
  sheet_count: number;
  last_updated_at: Date;
}

/**
 * **공부 노트** CRUD + 백링크 + 허브의 「회사 준비」 목록.
 *
 * ## 모든 경로가 user_id 로 잠긴다
 *
 * 노트·폴더·백링크·허브 어느 쪽도 id 만으로 조회하지 않는다. 어긋나면 **404** 다
 * (403 이면 "그 id 는 존재한다" 를 알려 주는 셈이라 준비 노트 시트와 같은 규칙을 쓴다).
 *
 * ## 저장과 링크 재계산은 한 트랜잭션
 *
 * 본문이 바뀌면 `study_note_links` 를 from 단위로 통째 재계산한다. 저장만 성공하고
 * 재계산이 실패하면 백링크가 조용히 어긋나고 사용자는 알 방법이 없다 — 그래서
 * 실패하면 저장까지 같이 롤백된다.
 *
 * ## streak 캐시
 *
 * `study_notes.updated_at` 이 streak source 라, 쓰기 경로마다 5분 캐시를 비운다
 * (`ActivityModule` 이 로그·회고 저장에서 하는 것과 같다). 안 비우면 "공부했는데
 * streak 이 안 는다" 가 최대 5분 이어진다 — 다른 source 는 즉시 반영되므로 비일관이다.
 */
@Injectable()
export class StudyNotesService {
  private readonly logger = new Logger(StudyNotesService.name);

  constructor(
    @InjectRepository(StudyNote)
    private readonly noteRepo: Repository<StudyNote>,
    private readonly dataSource: DataSource,
    private readonly streakService: StreakService,
    private readonly attachments: NoteAttachmentsService,
  ) {}

  /**
   * streak 캐시 무효화 — **best-effort**.
   *
   * 🔴 커밋이 끝난 **뒤에** 부르고, 실패해도 저장을 실패로 만들지 않는다.
   * 이 노트 저장은 자동저장이 굴리는 경로라, 캐시 정리 실패를 저장 실패로 되돌리면
   * 프론트가 "저장 실패" 를 띄우고 재시도한다 — 이미 저장된 글에 대해서다.
   * 캐시는 5분이면 알아서 만료되므로 최악이 "잠깐 늦게 반영" 이다.
   * (activity 쪽은 이 호출을 감싸지 않는데, 거긴 자동저장 경로가 아니다.)
   */
  private invalidateStreak(userId: string): void {
    try {
      this.streakService.invalidateCache(userId);
    } catch (e) {
      this.logger.warn(
        `streak 캐시 무효화 실패 (userId=${userId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 허브 목록 — **본문 제외**. 페이지네이션은 없다 (캡이 500이라 한 번에 실어도
   * 제목만이면 가볍고, 허브 검색이 클라 필터라 전체가 손에 있어야 한다).
   *
   * ## 백링크 수를 왜 여기서 같이 세나
   *
   * 허브 행이 배지로 보여 주는 값이라, 노트마다 따로 물으면 그게 N+1 이다.
   * `LEFT JOIN` 한 번으로 전부 붙여서 목록 쿼리를 **한 번**으로 유지한다.
   *
   * 🔴 세는 기준은 **백링크 패널과 같다** — 출처(from)가 내 것인 링크만.
   * 남의 문서가 내 노트를 가리키는 행이 있어도 패널은 안 보여 주므로(회사명 같은
   * 남의 정보가 새면 안 된다) 배지도 세면 안 된다. 두 숫자가 어긋나면 사용자는
   * 어느 쪽이 거짓말인지 알 수 없다. 그래서 조인 조건이 `backlinks()` 와 같은 모양이다.
   *
   * (API 로는 남의 노트를 가리키는 링크가 애초에 안 생긴다 — `syncStudyNoteLinks` 가
   *  소유권으로 거른다. 여기 필터는 그 방어선이 뚫렸을 때의 두 번째 겹이다.)
   */
  async list(userId: string): Promise<StudyNoteListItem[]> {
    const rows = await this.dataSource.query<StudyNoteListRow[]>(
      `
      SELECT n.id,
             n.title,
             n.folder_id,
             n.updated_at,
             COALESCE(b.cnt, 0)::int AS backlink_count
        FROM study_notes n
        LEFT JOIN (
          SELECT to_note_id, COUNT(*)::int AS cnt
            FROM (
              SELECT l.to_note_id
                FROM study_note_links l
                JOIN study_notes src ON src.id = l.from_id AND src.user_id = $1
               WHERE l.from_type = 'study'
              UNION ALL
              SELECT l.to_note_id
                FROM study_note_links l
                JOIN step_note_sheets sh ON sh.id = l.from_id
                JOIN application_steps st ON st.id = sh.step_id
                JOIN applications a ON a.id = st.application_id
               WHERE l.from_type = 'prep_sheet'
                 AND a.user_id = $1 AND a.deleted_at IS NULL
            ) owned
           GROUP BY to_note_id
        ) b ON b.to_note_id = n.id
       WHERE n.user_id = $1
       ORDER BY n.updated_at DESC
      `,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      folderId: r.folder_id,
      updatedAt: r.updated_at,
      backlinkCount: r.backlink_count,
    }));
  }

  async get(userId: string, id: string): Promise<StudyNote> {
    const note = await this.noteRepo.findOne({ where: { id, userId } });
    if (!note) throw new NotFoundException('노트를 찾을 수 없습니다.');
    return note;
  }

  async create(userId: string, dto: CreateStudyNoteDto): Promise<StudyNote> {
    // DB 를 만지기 전에 순수 검증부터 — 형식이 틀린 요청은 트랜잭션을 열 이유가 없다
    const title = normalizeTitle(dto.title ?? '');
    const content = dto.content ? dto.content : null;

    const note = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StudyNote);

      const count = await repo.count({ where: { userId } });
      if (count >= MAX_NOTES_PER_USER) {
        throw new BadRequestException(
          `공부 노트는 ${MAX_NOTES_PER_USER}개까지 만들 수 있어요 (현재 ${count}개).`,
        );
      }

      const folderId = await this.resolveFolderId(
        em,
        userId,
        dto.folderId ?? null,
      );

      const note = await repo.save(
        repo.create({ userId, title, content, folderId }),
      );

      // 새 행이라 기존 링크가 없다 — 멘션이 없으면 지울 것도 넣을 것도 없어 왕복을 건너뛴다
      if (content) {
        await syncStudyNoteLinks(
          em,
          { fromId: note.id, fromType: 'study', userId },
          content,
        );
      }
      return note;
    });

    // 🔴 커밋 뒤에. 롤백된 저장으로 캐시를 비우면 안 바뀐 streak 을 다시 계산하게 된다
    this.invalidateStreak(userId);
    return note;
  }

  /**
   * 저장 — **last-write-wins**. 두 탭이 같은 노트를 저장하면 나중 요청이 이긴다
   * (버전 컬럼도 병합도 없다. 1인 사용자의 멀티탭이 유일한 경합이고,
   *  충돌 해결 UI 는 그 빈도에 비해 너무 비싸다).
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateStudyNoteDto,
  ): Promise<StudyNote> {
    const note = await this.noteRepo.findOne({ where: { id, userId } });
    if (!note) throw new NotFoundException('노트를 찾을 수 없습니다.');

    if (dto.title !== undefined) note.title = normalizeTitle(dto.title);

    // 미전달과 null 을 구분한다 — 자동저장이 본문만 보내는데 폴더가 풀리면 안 된다
    const contentChanged = dto.content !== undefined;
    if (contentChanged) note.content = dto.content ? dto.content : null;

    // 트랜잭션 안에서 지운 첨부의 R2 URL — 커밋 뒤에 흘려보낸다 (closure 로 캡처)
    let orphanFileUrls: string[] = [];

    const saved = await this.dataSource.transaction(async (em) => {
      if (dto.folderId !== undefined) {
        note.folderId = await this.resolveFolderId(em, userId, dto.folderId);
      }

      const row = await em.getRepository(StudyNote).save(note);

      if (contentChanged) {
        await syncStudyNoteLinks(
          em,
          { fromId: id, fromType: 'study', userId },
          row.content,
        );
        // 🔴 같은 트랜잭션 — 정리가 실패하면 저장까지 롤백된다. 본문은 이미지를
        // 가리키는데 첨부 행이 없는 상태(또는 그 반대)가 되면 사용자는 복구할 수 없다
        orphanFileUrls = await this.attachments.reconcile(em, id, row.content);
      }
      return row;
    });

    // 🔴 커밋 뒤 best-effort — 롤백된 저장으로 R2 객체를 지우면 본문만 남고 그림이 사라진다
    await this.attachments.cleanupFiles(orphanFileUrls);

    // 편집 시각(updated_at)이 곧 streak source 다 — 저장 즉시 반영돼야 한다
    this.invalidateStreak(userId);
    return saved;
  }

  /** 영구 삭제 (휴지통 없음 — 프론트가 ConfirmModal 로 명시한다) */
  async remove(userId: string, id: string): Promise<void> {
    let fileUrls: string[] = [];

    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StudyNote);
      const note = await repo.findOne({ where: { id, userId } });
      if (!note) throw new NotFoundException('노트를 찾을 수 없습니다.');

      // 🔴 **지우기 전에** 모은다. 첨부 행은 note_id FK CASCADE 가 지우는데,
      // 지운 뒤엔 어떤 R2 객체를 지워야 하는지 알 방법이 없다
      fileUrls = await this.attachments.collectFileUrls(em, id);

      // 이 노트가 **내보낸** 링크. from 쪽엔 다형성이라 FK 가 없어 CASCADE 가 안 닿는다
      await em
        .getRepository(StudyNoteLink)
        .delete({ fromId: id, fromType: 'study' });

      // 이 노트를 **가리키던** 링크는 to_note_id FK CASCADE 가 지운다
      await repo.remove(note);
    });

    // 커밋 뒤 best-effort — 롤백됐다면 노트가 살아 있으므로 그림도 살아 있어야 한다
    await this.attachments.cleanupFiles(fileUrls);

    // 삭제도 heatmap 을 바꾼다 (그날의 마지막 노트였으면 칸이 비워진다)
    this.invalidateStreak(userId);
  }

  /**
   * 백링크 — 이 노트를 가리키는 문서 목록.
   *
   * 출처가 사라진 링크(삭제된 시트 등)는 **INNER JOIN 이라 결과에서 자동으로 빠진다.**
   * 두 소스 모두 `user_id` 를 조인 조건에 걸어, 남이 심어 둔 링크 행이 있어도 안 보인다.
   */
  async backlinks(userId: string, id: string): Promise<BacklinkItem[]> {
    await this.get(userId, id); // 소유권 — 남의 노트 백링크는 404

    const rows = await this.dataSource.query<BacklinkRow[]>(
      `
      SELECT 'study'::text AS from_type,
             l.from_id,
             sn.title,
             NULL::text AS company_name,
             NULL::text AS step_name,
             NULL::uuid AS application_id,
             NULL::uuid AS step_id,
             sn.updated_at AS sorted_at
        FROM study_note_links l
        JOIN study_notes sn ON sn.id = l.from_id AND sn.user_id = $2
       WHERE l.to_note_id = $1 AND l.from_type = 'study'
      UNION ALL
      SELECT 'prep_sheet'::text,
             l.from_id,
             NULL::text,
             a.company_name,
             st.name,
             a.id,
             st.id,
             sh.updated_at
        FROM study_note_links l
        JOIN step_note_sheets sh ON sh.id = l.from_id
        JOIN application_steps st ON st.id = sh.step_id
        JOIN applications a ON a.id = st.application_id
       WHERE l.to_note_id = $1 AND l.from_type = 'prep_sheet'
         AND a.user_id = $2 AND a.deleted_at IS NULL
       ORDER BY sorted_at DESC
      `,
      [id, userId],
    );

    return rows.map((r) => ({
      fromType: r.from_type,
      fromId: r.from_id,
      label:
        r.from_type === 'study'
          ? (r.title ?? '')
          : `${r.company_name ?? ''} — ${r.step_name ?? ''}`,
      applicationId: r.application_id,
      stepId: r.step_id,
    }));
  }

  /**
   * 허브의 「회사 준비」 목록 — 카드-스텝 단위 묶음.
   *
   * 데이터는 한 곳(준비 노트)에만 있고 허브는 **보여 주기만** 한다 (CEO 결정 1) —
   * 그래서 본문을 싣지 않고 개수·최종 수정만 준다. 클릭하면 프론트가 카드로 딥링크한다.
   *
   * ## 두 갈래인 이유 — 준비 노트는 두 곳에 산다
   *
   * | 갈래 | 대상 | 시트 수 | 최종 수정 |
   * |---|---|---|---|
   * | A | `step_note_sheets` 가 있는 스텝 | 실제 개수 | `MAX(sheets.updated_at)` |
   * | B | 시트 0장 + **유산 `steps.notes`** | **1** (가상 시트) | `applications.updated_at` |
   *
   * B 가 필요한 이유: ADR-079(8/13) 이전에 쓰고 그 뒤로 안 연 노트는 `steps.notes` 에만
   * 있다. 스텝 페이지는 그걸 **가상 첫 시트로 보여 준다** — 사용자 눈엔 실재하는 준비
   * 노트다. 허브에서만 빠지면 "내 노트가 다 보인다" 는 약속이 깨진다.
   * 시트 수를 1로 적는 것도 같은 이유고, 응답에 구분 플래그는 두지 않는다
   * (클릭하면 어차피 스텝 페이지가 같은 화면을 그린다).
   *
   * 🔴 **빈 문서 껍데기는 뺀다.** `NOT NULL AND <> ''` 만으로는 부족하다 —
   * 에디터를 열었다 아무것도 안 쓰고 나간 스텝에도
   * `{"type":"doc","content":[{"type":"paragraph"}]}` 가 저장돼 있다 (운영 dev DB 실측:
   * 내용 있는 노트 65건 중 1건). 그대로 두면 쓴 적 없는 준비 노트가 허브에 유령처럼 뜬다.
   * 공부 노트 쪽 「빈 노트 자동 정리」와 같은 판단이다.
   * 목록에 없는 모양은 **내용이 있는 쪽으로** 흘려보낸다 — 유령 한 줄보다 진짜 노트가
   * 안 보이는 게 더 나쁘다 (평문 유산 노트·구분선만 있는 문서는 그래서 통과한다).
   *
   * 🔴 **`a.updated_at AT TIME ZONE 'UTC'` 의 단일 hop 은 오타가 아니다.**
   * `applications.updated_at` 은 naive `timestamp`(TypeORM 이 프로세스 벽시각을 넣는다)이고
   * 시트 쪽은 `timestamptz` 다. 그냥 UNION 하면 Postgres 가 **세션 TZ 로** naive 를 승격해
   * 결과가 서버 TZ 에 따라 흔들린다 (2026-07-19 하루 어긋남 사고와 같은 부류).
   * 한 hop 으로 "naive UTC 벽시각 → 진짜 instant" 를 만들어 두 갈래 타입을 맞춘다.
   * `growth.service.ts` 가 같은 컬럼에 쓰는 규약과 동일하다 (거긴 KST 달력 날짜가 필요해
   * 두 번째 hop 을 더 붙인다 — 여기는 instant 를 그대로 돌려주므로 한 hop 에서 멈춘다).
   * ⚠️ 같은 전제로 dev(mac, TZ=KST)에서는 유산 행의 시각만 9h 어긋난다 (운영 TZ=UTC 정상).
   *
   * `application_steps` 에는 타임스탬프 컬럼이 아예 없어서 (created/updated 둘 다) 유산 행의
   * "최종 수정" 은 카드 시각으로 대신한다 — 노트를 고친 시각은 어디에도 안 남아 있다.
   */
  hubPrep(userId: string): Promise<PrepHubGroup[]> {
    return this.dataSource
      .query<PrepHubRow[]>(
        `
      SELECT a.id AS application_id,
             a.company_name,
             st.id AS step_id,
             st.name AS step_name,
             COUNT(sh.id)::int AS sheet_count,
             MAX(sh.updated_at) AS last_updated_at
        FROM step_note_sheets sh
        JOIN application_steps st ON st.id = sh.step_id
        JOIN applications a ON a.id = st.application_id
       WHERE a.user_id = $1 AND a.deleted_at IS NULL
       GROUP BY a.id, a.company_name, st.id, st.name
      UNION ALL
      SELECT a.id,
             a.company_name,
             st.id,
             st.name,
             1 AS sheet_count,
             a.updated_at AT TIME ZONE 'UTC' AS last_updated_at
        FROM application_steps st
        JOIN applications a ON a.id = st.application_id
       WHERE a.user_id = $1 AND a.deleted_at IS NULL
         AND st.notes IS NOT NULL
         AND btrim(st.notes) <> ''
         AND regexp_replace(st.notes, '\\s+', '', 'g') NOT IN (
               '{"type":"doc","content":[{"type":"paragraph"}]}',
               '{"type":"doc","content":[{"type":"paragraph","content":[]}]}',
               '{"type":"doc","content":[]}',
               '{"type":"doc"}'
             )
         AND NOT EXISTS (
               SELECT 1 FROM step_note_sheets sh WHERE sh.step_id = st.id
             )
       ORDER BY last_updated_at DESC
      `,
        [userId],
      )
      .then((rows) =>
        rows.map((r) => ({
          applicationId: r.application_id,
          companyName: r.company_name,
          stepId: r.step_id,
          stepName: r.step_name,
          sheetCount: r.sheet_count,
          lastUpdatedAt: r.last_updated_at,
        })),
      );
  }

  /**
   * 폴더 지정 검증. 없는 폴더와 남의 폴더를 **같은 문구**로 되돌린다
   * (존재 여부를 알려 주지 않는다). 404 가 아니라 400 인 이유 — 못 찾은 건
   * 요청한 노트가 아니라 **본문에 실린 값**이다.
   */
  private async resolveFolderId(
    em: EntityManager,
    userId: string,
    folderId: string | null,
  ): Promise<string | null> {
    if (folderId === null) return null;

    const folder = await em
      .getRepository(StudyNoteFolder)
      .findOne({ where: { id: folderId, userId } });
    if (!folder) throw new BadRequestException('폴더를 찾을 수 없어요.');

    return folderId;
  }
}
