import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { syncStudyNoteLinks } from '../study-notes/mention-links';
import { StudyNoteLink } from '../study-notes/study-note-link.entity';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepNoteSheet } from './step-note-sheet.entity';
import {
  CreateStepNoteSheetDto,
  UpdateStepNoteSheetDto,
} from './dto/step-note-sheet.dto';

/**
 * 스텝당 시트 상한. 숫자를 문구에 실어 400 으로 되돌린다 (무엇을 줄여야 하는지 알게).
 * 탭 줄이 한 화면에 들어가는 한계이자, 한 스텝이 문서 저장소가 되는 걸 막는 선이다.
 */
export const MAX_SHEETS_PER_STEP = 10;

/** 시트 이름 — **trim 후** 판정 */
export const SHEET_NAME_MAX_CHARS = 50;

/**
 * 이름 정규화 + 길이 판정의 **단일 지점**.
 *
 * trim 을 먼저 하는 이유는 붙여넣은 이름이 공백을 달고 오기 때문이다 —
 * raw 길이로 자르면 멀쩡한 50자가 막히고, raw 로 통과시키면 공백만 있는 탭이 생긴다.
 * 둘 다 사용자가 원인을 알 수 없는 실패라 판정을 한 곳에 모은다.
 */
function normalizeSheetName(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || trimmed.length > SHEET_NAME_MAX_CHARS) {
    throw new BadRequestException(
      `시트 이름은 공백을 뺀 1~${SHEET_NAME_MAX_CHARS}자로 입력해 주세요.`,
    );
  }
  return trimmed;
}

/** POST 응답 — 승격이 실제로 일어났는지(201) 기존 시트를 돌려준 건지(200) 컨트롤러가 구분한다 */
export interface CreateSheetResult {
  sheet: StepNoteSheet;
  created: boolean;
}

/**
 * 준비 노트 **다중 시트** CRUD.
 *
 * ## 🔴 최상위 불변식 — 기존 노트는 절대 안 날아간다
 *
 * 이 서비스는 `application_steps.notes` 에 **UPDATE·DELETE 를 내보내지 않는다.**
 * 스텝 행은 소유권 확인과 잠금(`SELECT ... FOR UPDATE`) 목적으로만 읽는다.
 * 기존 노트 저장 API(`PATCH /applications/:id/steps/:stepId`)는 그대로 살아 있고
 * (프론트 구버전 호환), 승격은 **복사**지 이동이 아니다 — 원본이 남아 있어야
 * 되돌릴 자리가 있다. 이 불변식은 spec 이 잠근다.
 *
 * ## 소유권 체인 (3-hop)
 *
 * sheet → step → application → user. 기존 체크리스트 CRUD 와 같은 규칙이고,
 * 어긋나면 전부 **404** 다 (존재 여부를 알려 주지 않는다).
 *
 * ## 왜 스텝 행을 잠그는가
 *
 * "10장 상한", "마지막 1장은 못 지움", "0장일 때만 승격" 은 전부 **행 하나가 아니라
 * 집합에 걸린 제약**이라 CHECK 로 표현할 수 없다. 트랜잭션만으로도 부족하다 —
 * READ COMMITTED 에서 동시 POST 둘은 서로의 미커밋 INSERT 를 못 봐서 둘 다 통과한다.
 * 그래서 부모(스텝) 행을 `FOR UPDATE` 로 잠가 **한 스텝의 시트 변경을 직렬화**한다.
 * 잠금 구간은 count + insert 한 번이라 짧고, 경합 상대는 같은 스텝을 동시에 만지는
 * 자기 자신뿐이다.
 *
 * ## 공부 노트 멘션 (study-notes)
 *
 * 시트 본문이 저장될 때 `study_note_links` 를 **이 시트 단위로 통째 재계산**한다
 * (`from_type='prep_sheet'`). 준비 노트에서 공부 노트를 참조할 수 있어야
 * 같은 자료를 카드마다 복제할 이유가 사라지기 때문이다.
 * 시트가 삭제되면 그 시트가 내보낸 링크도 같은 트랜잭션에서 지운다 (`from_id` 는
 * 다형성이라 FK CASCADE 가 안 닿는다).
 * 재계산은 순수 함수(`mention-links.ts`)를 부르는 것뿐이라 모듈 의존은 생기지 않는다.
 */
@Injectable()
export class StepNoteSheetsService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(StepNoteSheet)
    private readonly sheetRepo: Repository<StepNoteSheet>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 소유권 체인 확인 (읽기 전용). 어긋나면 404 — 정보 누출 방지.
   *
   * 노트 AI 패널(`StepAiActionController`)도 같은 3-hop 을 봐야 해서 공개했다 —
   * 같은 판정을 두 곳에 적으면 한쪽만 고쳐지는 날이 온다.
   */
  async assertOwnsStep(
    userId: string,
    appId: string,
    stepId: string,
  ): Promise<void> {
    const app = await this.appRepo.findOne({ where: { id: appId, userId } });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');

    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');
  }

  /**
   * 소유권 확인 + 스텝 행 잠금 + 콜백을 **한 트랜잭션**으로 묶는다.
   * 집합 제약(캡·마지막 1장·승격 멱등)을 보는 쓰기 경로가 전부 이 문을 통과한다.
   */
  private async withStepLocked<T>(
    userId: string,
    appId: string,
    stepId: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      const app = await em.findOne(Application, {
        where: { id: appId, userId },
      });
      if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');

      // 🔴 읽기 + 잠금만 한다. 이 행(= steps.notes 를 가진 행)에 쓰기는 없다.
      const step = await em.findOne(ApplicationStep, {
        where: { id: stepId, applicationId: appId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

      return fn(em);
    });
  }

  async list(
    userId: string,
    appId: string,
    stepId: string,
  ): Promise<StepNoteSheet[]> {
    await this.assertOwnsStep(userId, appId, stepId);

    // 0장이면 빈 배열. 기존 notes 를 첫 시트로 보여 주는 폴백은 프론트 몫이다 —
    // 서버가 가짜 시트를 지어내면 그 id 로 PATCH 가 오는 순간 404 가 된다.
    return this.sheetRepo.find({
      where: { stepId },
      order: { orderIndex: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(
    userId: string,
    appId: string,
    stepId: string,
    dto: CreateStepNoteSheetDto,
  ): Promise<CreateSheetResult> {
    // DB 를 만지기 전에 순수 검증부터 — 형식이 틀린 요청은 커넥션도 잠금도 쓸 이유가 없다
    const name = normalizeSheetName(dto.name);

    return this.withStepLocked(userId, appId, stepId, async (em) => {
      const repo = em.getRepository(StepNoteSheet);
      const existing = await repo.find({
        where: { stepId },
        order: { orderIndex: 'ASC', createdAt: 'ASC' },
      });

      /**
       * 🔴 승격 멱등 — 캡보다 **먼저** 본다.
       * 이미 시트가 있는 스텝에 승격 요청이 또 오면 그건 재시도지 실패가 아니다.
       * (10장 꽉 찬 스텝에 승격이 와도 400 이 아니라 첫 시트를 돌려줘야 화면이 뜬다.)
       */
      if (dto.ifEmpty && existing.length > 0) {
        return { sheet: existing[0], created: false };
      }

      if (existing.length >= MAX_SHEETS_PER_STEP) {
        throw new BadRequestException(
          `준비 노트 시트는 스텝당 ${MAX_SHEETS_PER_STEP}장까지예요 (현재 ${existing.length}장).`,
        );
      }

      const nextOrderIndex =
        existing.reduce((max, s) => Math.max(max, s.orderIndex), -1) + 1;

      const sheet = await repo.save(
        repo.create({
          stepId,
          name,
          content: dto.content ?? null,
          orderIndex: nextOrderIndex,
        }),
      );

      // 승격으로 들어온 본문에도 공부 노트 멘션이 있을 수 있다. 새 행이라 기존 링크가
      // 없으니 본문이 없을 때는 지울 것도 넣을 것도 없다 (흔한 경우 = 빈 시트 추가).
      if (sheet.content) {
        await syncStudyNoteLinks(
          em,
          { fromId: sheet.id, fromType: 'prep_sheet', userId },
          sheet.content,
        );
      }
      return { sheet, created: true };
    });
  }

  async update(
    userId: string,
    appId: string,
    stepId: string,
    sheetId: string,
    dto: UpdateStepNoteSheetDto,
  ): Promise<StepNoteSheet> {
    await this.assertOwnsStep(userId, appId, stepId);

    const sheet = await this.sheetRepo.findOne({
      where: { id: sheetId, stepId },
    });
    if (!sheet) throw new NotFoundException('시트를 찾을 수 없습니다.');

    if (dto.name !== undefined) sheet.name = normalizeSheetName(dto.name);
    // 빈 문자열 → null (기존 steps.notes 저장과 같은 정규화)
    if (dto.content !== undefined) sheet.content = dto.content || null;
    if (dto.orderIndex !== undefined) sheet.orderIndex = dto.orderIndex;

    // 본문이 안 실려 온 저장(이름 바꾸기·순서 변경)은 멘션도 그대로다 — 트랜잭션을 열 이유가 없다
    if (dto.content === undefined) return this.sheetRepo.save(sheet);

    /**
     * 🔴 본문 저장과 링크 재계산은 **한 트랜잭션**. 저장만 성공하고 재계산이 실패하면
     * 공부 노트 쪽 백링크가 조용히 어긋나고, 사용자는 알 방법이 없다.
     * (from 쪽 소유권은 위 `assertOwnsStep` 이 이미 확인했고, to 쪽 노트 소유권은
     *  `syncStudyNoteLinks` 가 userId 로 다시 거른다.)
     */
    return this.dataSource.transaction(async (em) => {
      const saved = await em.getRepository(StepNoteSheet).save(sheet);
      await syncStudyNoteLinks(
        em,
        { fromId: sheet.id, fromType: 'prep_sheet', userId },
        saved.content,
      );
      return saved;
    });
  }

  async remove(
    userId: string,
    appId: string,
    stepId: string,
    sheetId: string,
  ): Promise<void> {
    await this.withStepLocked(userId, appId, stepId, async (em) => {
      const repo = em.getRepository(StepNoteSheet);

      // 없는 시트는 마지막 1장 판정보다 먼저 404 — 남의 시트 id 로 상태를 떠보지 못하게
      const sheet = await repo.findOne({ where: { id: sheetId, stepId } });
      if (!sheet) throw new NotFoundException('시트를 찾을 수 없습니다.');

      const count = await repo.count({ where: { stepId } });
      if (count <= 1) {
        throw new BadRequestException('시트는 1장 이상 있어야 해요.');
      }

      /**
       * 이 시트가 **내보낸** 멘션 링크. `from_id` 는 다형성이라 FK 가 없어
       * CASCADE 가 안 닿는다 — 안 지우면 가리키던 공부 노트 쪽에 출처가 사라진
       * 행이 남는다. 조회는 INNER JOIN 이라 화면엔 안 보이지만, 공부 노트 삭제
       * 경로가 자기 링크를 정리하는 것과 정책을 맞춘다 (고아를 남기지 않는다).
       */
      await em
        .getRepository(StudyNoteLink)
        .delete({ fromId: sheetId, fromType: 'prep_sheet' });

      await repo.remove(sheet);
    });
  }
}
