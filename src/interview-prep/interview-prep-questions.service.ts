import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BulkCreateQuestionsDto } from './dto/bulk-create-questions.dto';
import { PracticeResult } from './dto/practice-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

/** 질문 출처 — 컬럼 `source` 의 두 값 */
export const QUESTION_SOURCE_AI = 'ai';
export const QUESTION_SOURCE_USER = 'user';

/**
 * 캡 3종 — 전부 **숫자를 문구에 실어** 400 으로 되돌린다 (사용자가 무엇을 줄여야 할지 알게).
 *
 * - 세션당 커스텀 100: 은행이 커지는 건 좋지만, 한 세션은 한 차수의 면접이다.
 *   100개를 넘겼다면 세션을 나누는 게 맞다 (연습 루프도 그 편이 쓸 만하다).
 * - 부모당 직접 꼬리 10: 🔴 **AI 꼬리와 달리 공짜라 상한이 없으면 무한히 달린다.**
 *   비용이 막아 주지 않는 자리에는 숫자를 둔다.
 * - 한 번에 50: 붙여넣기 브리지의 상한과 같다 (`BULK_MAX_ITEMS`, DTO 가 강제).
 */
export const MAX_CUSTOM_QUESTIONS_PER_SESSION = 100;
export const MAX_CUSTOM_CHILDREN_PER_PARENT = 10;

/**
 * 세션당 AI 메인 질문(depth 0) 상한 (질문 은행 D1b).
 *
 * 🔴 생성이 additive 가 되면서 **개수가 무한히 커질 수 있게 됐다** — 전에는 매번
 * 전량 삭제 후 20개라 상한이 필요 없었다. 코인이 제동을 걸긴 하지만, 100개짜리 세션은
 * 연습 루프에서 쓸 수 없고 중복 회피 프롬프트도 입력 캡을 밀어 올린다.
 * 판정 대상은 **AI · depth 0** 뿐이다 (꼬리는 코인이 제동, 커스텀은 별도 캡 100).
 */
export const MAX_AI_QUESTIONS_PER_SESSION = 60;

/** 질문 본문 길이 — **trim 후** 판정 */
export const QUESTION_TEXT_MAX_CHARS = 500;

/**
 * 질문 본문 정규화 + 길이 판정 (trim 후 1~500자).
 *
 * 🔴 **trim 을 먼저 하는 이유** — 붙여넣기로 들어온 줄은 끝에 개행·공백을 달고 온다.
 * raw 길이로 자르면 멀쩡한 500자가 막히고, raw 로 통과시키면 공백만 있는 줄이 저장된다.
 * 둘 다 사용자가 원인을 알 수 없는 실패라 판정 지점을 하나로 모았다.
 */
function normalizeQuestionText(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || trimmed.length > QUESTION_TEXT_MAX_CHARS) {
    throw new BadRequestException(
      `질문은 공백을 뺀 1~${QUESTION_TEXT_MAX_CHARS}자로 입력해 주세요.`,
    );
  }
  return trimmed;
}

/**
 * depth 규칙의 **단일 지점** (`MAX_DEPTH_REACHED`).
 * 자식 depth = parent.depth + 1 이므로 parent.depth=2 면 자식이 3 이 되어 차단된다.
 * AI 꼬리(`assertCanCreateFollowup`)와 직접 꼬리(`bulkCreate`)가 같은 함수를 쓴다 —
 * 규칙이 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
 */
function assertParentDepthAllowsChild(parent: { depth: number }): void {
  if (parent.depth >= 2) {
    throw new BadRequestException(
      '꼬리질문은 최대 2단계까지만 만들 수 있어요.',
    );
  }
}

/** 루트 판정에 필요한 최소 형태 — 트리를 다 로드하지 않아도 되게 좁혀 둔다 */
type TreeWalkNode = Pick<
  InterviewPrepQuestion,
  'id' | 'parentQuestionId' | 'source'
>;

/**
 * parent 체인을 거슬러 올라가 **트리의 루트**를 찾는다.
 *
 * depth 가 0~2 라 홉은 최대 2번이면 끝나지만, 루프 상한을 명시로 둔다 —
 * 데이터가 어떤 이유로든 순환하면 walk-up 이 서버를 멈춰 세우기 때문이다
 * (자기참조 FK 는 순환을 막아 주지 않는다).
 */
function resolveRootQuestion<T extends TreeWalkNode>(
  parent: T,
  byId: Map<string, T>,
): T {
  let node = parent;
  for (let hop = 0; hop < 2 && node.parentQuestionId; hop++) {
    const up = byId.get(node.parentQuestionId);
    if (!up) break;
    node = up;
  }
  return node;
}

/**
 * F6 PR 2 Phase 2 — InterviewPrepQuestionsService.
 *
 * **트리 fetch** — recursive CTE 로 session 의 모든 question 한 번에 가져온 뒤 client-side 로 트리화.
 * depth 0~2 보장 (DB CHECK + service 가드).
 *
 * **followup depth limit**:
 * - parent.depth=0 → child depth=1 OK
 * - parent.depth=1 → child depth=2 OK
 * - parent.depth=2 → 4번째 depth 시도 → BadRequest (`MAX_DEPTH_REACHED`)
 *
 * **my_memo autosave** — 단순 PATCH. 빈 string 은 null 로 정규화.
 */
export interface QuestionNode {
  id: string;
  sessionId: string;
  parentQuestionId: string | null;
  depth: number;
  orderIndex: number;
  /**
   * 질문 유형 (`INTERVIEW_CATEGORIES`). 화면이 문항마다 태그로 보여준다.
   *
   * 🔴 저장은 되는데 **응답에서 빠져 있었다** (2026-08-07 발견). 프론트는
   * `CATEGORY_LABEL[question.category]` 로 칩을 그리는데 값이 없으니 조건부 렌더가
   * 항상 거짓이라 **태그가 한 번도 보인 적이 없다.** 컬럼 select 누락이었다.
   */
  category: string | null;
  /** 우선 준비 대상 (v2.1) — 20문항 중 먼저 할 5~7개 */
  mustPrepare: boolean;
  /** 꼬리질문이 무엇을 파고들었는지 (v2.1). 메인은 null */
  followupBasis: string | null;
  questionText: string;
  suggestedAnswer: string | null;
  /**
   * AI 답변의 자료 부족 사유 (v2.2). null = 충분.
   *
   * 🔴 이건 **답변 본문에 들어가면 안 되는 내용**이라 필드를 나눴다 — `suggestedAnswer` 는
   * 면접장에서 그대로 말할 문장이고, 여기는 사용자에게 하는 안내다. 화면이 배지로 그린다.
   */
  materialGap: string | null;
  sourceLogIds: string[];
  myMemo: string | null;
  /**
   * `'ai'` | `'user'` — 질문 은행 D1.
   *
   * 🔴 **응답에 반드시 실어야 한다.** 화면의 「내 질문」 배지·수정 버튼 노출·면접 보기의
   * 출처 필터가 전부 이 값으로 갈린다. 저장은 되는데 응답에서 빠져 조건부 렌더가 늘
   * 거짓이었던 `category` 사고(2026-08-07)가 정확히 같은 모양이었다.
   */
  source: string;
  /** 마지막 연습 시각 (서버 시각). 표시는 프론트 `@/utils/datetime` 이 KST 로 그린다 */
  lastPracticedAt: Date | null;
  /** `'good'` | `'soso'` | `'again'` | null — 「다시 볼 것만」 필터의 근거 */
  lastPracticeResult: string | null;
  createdAt: Date;
  updatedAt: Date;
  children: QuestionNode[];
}

@Injectable()
export class InterviewPrepQuestionsService {
  constructor(
    @InjectRepository(InterviewPrepQuestion)
    private readonly questionRepo: Repository<InterviewPrepQuestion>,
    private readonly sessionsService: InterviewPrepSessionsService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * session 의 모든 question 을 트리 구조로 반환.
   * 본인 소유 session 인지 가드 후 recursive CTE 로 한 쿼리에 fetch.
   */
  async listTreeBySession(
    userId: string,
    sessionId: string,
  ): Promise<QuestionNode[]> {
    await this.sessionsService.findOwnedRaw(userId, sessionId);

    // depth 0 부터 BFS 로 자식 따라 내려가며 트리 구성.
    // recursive CTE 결과는 depth 순서 + order_index 순서로 정렬되어 옴.
    type Row = {
      id: string;
      session_id: string;
      parent_question_id: string | null;
      depth: number;
      order_index: number;
      category: string | null;
      must_prepare: boolean;
      followup_basis: string | null;
      question_text: string;
      suggested_answer: string | null;
      material_gap: string | null;
      source_log_ids: string[];
      my_memo: string | null;
      source: string;
      last_practiced_at: Date | null;
      last_practice_result: string | null;
      created_at: Date;
      updated_at: Date;
    };
    const rows = await this.dataSource.query<Row[]>(
      `
      WITH RECURSIVE tree AS (
        SELECT q.*, 0 AS lvl
        FROM interview_prep_questions q
        WHERE q.session_id = $1 AND q.parent_question_id IS NULL
        UNION ALL
        SELECT q.*, t.lvl + 1
        FROM interview_prep_questions q
        INNER JOIN tree t ON q.parent_question_id = t.id
      )
      SELECT id, session_id, parent_question_id, depth, order_index,
             category, must_prepare, followup_basis,
             question_text, suggested_answer, material_gap, source_log_ids, my_memo,
             source, last_practiced_at, last_practice_result,
             created_at, updated_at
      FROM tree
      ORDER BY depth ASC, order_index ASC, created_at ASC
      `,
      [sessionId],
    );

    // id → node map + parent_id 로 children 묶기
    const nodeMap = new Map<string, QuestionNode>();
    rows.forEach((r) => {
      nodeMap.set(r.id, {
        id: r.id,
        sessionId: r.session_id,
        parentQuestionId: r.parent_question_id,
        depth: r.depth,
        orderIndex: r.order_index,
        category: r.category,
        mustPrepare: r.must_prepare === true,
        followupBasis: r.followup_basis,
        questionText: r.question_text,
        suggestedAnswer: r.suggested_answer,
        materialGap: r.material_gap,
        sourceLogIds: Array.isArray(r.source_log_ids) ? r.source_log_ids : [],
        myMemo: r.my_memo,
        source: r.source ?? QUESTION_SOURCE_AI,
        lastPracticedAt: r.last_practiced_at,
        lastPracticeResult: r.last_practice_result,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        children: [],
      });
    });
    const roots: QuestionNode[] = [];
    nodeMap.forEach((node) => {
      if (node.parentQuestionId) {
        const parent = nodeMap.get(node.parentQuestionId);
        if (parent) parent.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }

  /** 본인 소유 + raw entity 반환 — followup·update 의 가드 */
  async findOwnedRaw(
    userId: string,
    questionId: string,
  ): Promise<InterviewPrepQuestion> {
    const q = await this.questionRepo
      .createQueryBuilder('q')
      .innerJoin('q.session', 's')
      .where('q.id = :id', { id: questionId })
      .andWhere('s.user_id = :userId', { userId })
      .getOne();
    if (!q) throw new NotFoundException('질문을 찾을 수 없습니다.');
    return q;
  }

  /**
   * my_memo PATCH (autosave 대상). suggestedAnswer 변경은 차단 — LLM 호출만 변경 가능.
   * 빈 문자열은 null 로 정규화.
   *
   * 질문 은행 D1 — `questionText`·`category` 추가. 🔴 **그 둘만 `source='user'` 전용**이고
   * `myMemo` 는 출처와 무관하게 열려 있다 (내 답변은 AI 질문에도 쓴다).
   */
  async update(
    userId: string,
    questionId: string,
    dto: UpdateQuestionDto,
  ): Promise<QuestionNode> {
    const q = await this.findOwnedRaw(userId, questionId);

    /**
     * 🔴 AI 질문의 **본문**은 못 고친다 — 고칠 수 있게 하면 ↻(낱개 교체)의 기준이 사라진다.
     *   "AI 가 준 질문" 이 아니게 된 것을 무엇을 근거로 다시 뽑을지가 없어지기 때문이다.
     *   막다른 길이 되지 않게 문구가 **대안(삭제)** 을 같이 알려 준다.
     */
    if (dto.questionText !== undefined || dto.category !== undefined) {
      if (q.source !== QUESTION_SOURCE_USER) {
        throw new BadRequestException(
          'AI 가 만든 질문은 내용을 고칠 수 없어요. 마음에 안 들면 삭제해 주세요.',
        );
      }
    }

    if (dto.myMemo !== undefined) {
      const trimmed = (dto.myMemo ?? '').trim();
      q.myMemo = trimmed.length === 0 ? null : trimmed;
    }
    /**
     * 🔴 **⭐ 는 모든 질문에서 켤 수 있다** (D1a 판정 #4). `mustPrepare` 는 원래
     * LLM 전용 필드였는데, 그 상태로 「⭐만」 필터를 내보내면 **직접 추가한 질문에서는
     * 영원히 빈 목록**이 나온다 — 은행의 중심이 「내가 모은 질문」인데 우선순위를
     * 못 매기는 셈이다. `questionText`·`category` 의 user 전용 제한과 성격이 다르다
     * (그건 "AI 가 만든 것" 의 정체성 문제이고, 이건 내 준비 표시다).
     */
    if (dto.mustPrepare !== undefined) {
      q.mustPrepare = dto.mustPrepare;
    }
    if (dto.questionText !== undefined) {
      q.questionText = normalizeQuestionText(dto.questionText);
    }
    // null 을 보내면 미분류로 되돌린다 (기존 질문의 `category = null` 과 같은 뜻)
    if (dto.category !== undefined) {
      q.category = dto.category ?? null;
    }

    await this.questionRepo.save(q);
    return this.toNode(q);
  }

  /**
   * 질문 은행 — 사용자가 직접 추가하는 질문 N개 (1~50) 를 한 번에 넣는다.
   *
   * 단건 추가 / 붙여넣기 / 직접 꼬리를 **한 메서드로 단일화**했다. 셋 다 하는 일이 같고,
   * 나누면 캡·순서·트랜잭션 규칙을 세 번 구현하게 된다.
   *
   * 🔴 **전부 성공 아니면 전부 없던 일** — 붙여넣기 30줄 중 22번째가 캡에 걸렸을 때
   * 21개만 들어가 있으면, 사용자는 무엇이 들어갔는지 세어 봐야 하고 재시도는 중복을 만든다.
   * 그래서 판정도 저장도 한 트랜잭션 안에서 한다.
   */
  async bulkCreate(
    userId: string,
    sessionId: string,
    dto: BulkCreateQuestionsDto,
  ): Promise<QuestionNode[]> {
    await this.sessionsService.findOwnedRaw(userId, sessionId);

    // DB 를 만지기 전에 순수 검증부터 — 형식이 틀린 요청은 커넥션을 쓸 이유가 없다
    const items = dto.items.map((item) => ({
      questionText: normalizeQuestionText(item.questionText),
      category: item.category ?? null,
      parentQuestionId: item.parentQuestionId ?? null,
    }));

    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(InterviewPrepQuestion);

      /**
       * 🔴 세션의 질문을 **한 번에 다 읽는다.** 캡 판정(세션 커스텀 수 · 부모당 꼬리 수),
       * 부모 존재·소유 판정, 다음 order_index 가 전부 이 한 배열에서 나온다.
       * 세션당 행은 AI 60 + 커스텀 100 이 상한이라 메모리로 올려도 되는 크기고,
       * 쿼리를 4번 나누면 그 사이에 스냅샷이 갈린다.
       */
      const existing = await repo.find({
        where: { sessionId },
        select: ['id', 'parentQuestionId', 'depth', 'orderIndex', 'source'],
      });

      const customCount = existing.filter(
        (q) => q.source === QUESTION_SOURCE_USER,
      ).length;
      if (customCount + items.length > MAX_CUSTOM_QUESTIONS_PER_SESSION) {
        throw new BadRequestException(
          `직접 추가한 질문은 세션당 ${MAX_CUSTOM_QUESTIONS_PER_SESSION}개까지예요 ` +
            `(현재 ${customCount}개, 요청 ${items.length}개).`,
        );
      }

      const byId = new Map(existing.map((q) => [q.id, q]));

      // 부모별로 이번 배치가 새로 다는 개수 (캡은 기존 + 이번 배치 합으로 본다)
      const addingPerParent = new Map<string, number>();
      for (const item of items) {
        const parentId = item.parentQuestionId;
        if (!parentId) continue;

        /**
         * 세션 소유는 위에서 이미 확인했으므로, **부모가 이 세션의 질문 목록에 있는지**가
         * 곧 소유·같은 세션 검증이다. 남의 질문이든 다른 세션이든 없는 id 든 전부 여기서
         * 갈리고 응답은 404 하나다 (존재 여부를 알려 주지 않는다).
         */
        const parent = byId.get(parentId);
        if (!parent) {
          throw new NotFoundException('꼬리질문을 달 질문을 찾을 수 없습니다.');
        }
        assertParentDepthAllowsChild(parent);

        /**
         * 🔴 **루트가 내 질문인 트리 안에만** 직접 꼬리를 단다.
         * AI 트리는 ↻·삭제로 통째 사라질 수 있어서, 거기 단 내 꼬리는 같이 증발한다.
         * 고아를 톱레벨로 승격시키는 마법을 넣는 대신 **처음부터 못 달게** 한다
         * (우회로는 톱레벨 추가 — 잃을 게 없는 길이 항상 열려 있다).
         */
        const root = resolveRootQuestion(parent, byId);
        if (root.source !== QUESTION_SOURCE_USER) {
          throw new BadRequestException(
            'AI 가 만든 질문에는 직접 꼬리질문을 달 수 없어요. 질문으로 새로 추가해 주세요.',
          );
        }

        addingPerParent.set(parentId, (addingPerParent.get(parentId) ?? 0) + 1);
      }

      for (const [parentId, adding] of addingPerParent) {
        const already = existing.filter(
          (q) =>
            q.parentQuestionId === parentId &&
            q.source === QUESTION_SOURCE_USER,
        ).length;
        if (already + adding > MAX_CUSTOM_CHILDREN_PER_PARENT) {
          throw new BadRequestException(
            `직접 꼬리질문은 질문 하나당 ${MAX_CUSTOM_CHILDREN_PER_PARENT}개까지예요 (현재 ${already}개).`,
          );
        }
      }

      /**
       * order_index 는 **세션 전체 max + 1** 부터 순서대로 준다.
       * AI 꼬리는 부모별 max + 1 을 쓰는데(형제 안 순서), 둘을 섞어도 정렬은 안 깨진다 —
       * 트리 조회가 `depth ASC, order_index ASC` 라 나중에 넣은 것이 항상 뒤에 온다.
       * 배치 안 순서(붙여넣은 줄 순서)가 그대로 보이는 게 여기선 더 중요하다.
       */
      let nextOrderIndex =
        existing.reduce((max, q) => Math.max(max, q.orderIndex), -1) + 1;

      const entities = items.map((item) =>
        repo.create({
          sessionId,
          parentQuestionId: item.parentQuestionId,
          depth: item.parentQuestionId
            ? (byId.get(item.parentQuestionId)?.depth ?? 0) + 1
            : 0,
          orderIndex: nextOrderIndex++,
          questionText: item.questionText,
          category: item.category,
          source: QUESTION_SOURCE_USER,
          // 아래는 전부 AI 만 채우는 자리 — 명시해 두지 않으면 응답에 undefined 가 실린다
          mustPrepare: false,
          followupBasis: null,
          suggestedAnswer: null,
          materialGap: null,
          sourceLogIds: [],
          myMemo: null,
        }),
      );

      const saved = await repo.save(entities);
      return saved.map((q) => this.toNode(q));
    });
  }

  /**
   * 「면접 보기」 자가평가 저장 — 문항 하나의 최신 결과만 남긴다 (이력 테이블은 Out of Scope).
   *
   * 🔴 **시각은 서버 `now()`.** DTO 에 시각 필드 자체가 없다 — 클라이언트가 보낸 시각을
   * 믿으면 기기 시계를 바꾸는 것만으로 "최근에 안 본 것" 순서를 조작할 수 있다.
   */
  async recordPractice(
    userId: string,
    questionId: string,
    result: PracticeResult,
  ): Promise<QuestionNode> {
    const q = await this.findOwnedRaw(userId, questionId);
    q.lastPracticeResult = result;
    q.lastPracticedAt = new Date();
    await this.questionRepo.save(q);
    return this.toNode(q);
  }

  /**
   * 질문 삭제 — **AI·내 질문 가리지 않고** 허용한다 (질문 은행 계획 §3A).
   *
   * AI 질문 삭제를 막던 근거는 "일괄 재생성이 전부 지우므로 트리 불변식을 지켜야 한다"
   * 였는데, 재생성이 additive 로 바뀌며 그 근거가 사라졌다. 질문이 별로면 버릴 수 있어야 한다.
   *
   * 🔴 **자손은 FK `ON DELETE CASCADE` 가 지운다** (`parent_question_id` 자기참조).
   * 여기서 트리를 직접 걸어 지우지 않는 이유는, 같은 규칙이 두 곳에 생기면 DB 와 코드가
   * 갈라지는 날이 오기 때문이다. 동반 삭제 검증은 실 DB 를 쓰는 e2e 가 한다.
   *
   * 내용(답변·꼬리)이 있는지 확인하고 물어보는 건 **프론트 몫**이다 — 서버는 지운다.
   */
  async remove(userId: string, questionId: string): Promise<void> {
    const q = await this.findOwnedRaw(userId, questionId);
    await this.questionRepo.remove(q);
  }

  /**
   * AI followup 생성 직전 가드 — parent 의 depth 가 2 면 차단.
   * 새 질문은 child depth = parent.depth + 1 이 되므로 parent.depth=2 면 자식 depth=3 → 차단.
   * service 호출 측 (InterviewPrepAiService) 가 본 메서드 호출 후 LLM 진입.
   */
  async assertCanCreateFollowup(
    userId: string,
    parentQuestionId: string,
  ): Promise<InterviewPrepQuestion> {
    const parent = await this.findOwnedRaw(userId, parentQuestionId);
    // 직접 꼬리(`bulkCreate`)와 **같은 함수**로 판정한다 — 규칙이 두 벌이 되지 않게
    assertParentDepthAllowsChild(parent);
    return parent;
  }

  /** raw → response node (children 없이) */
  private toNode(q: InterviewPrepQuestion): QuestionNode {
    return {
      id: q.id,
      sessionId: q.sessionId,
      parentQuestionId: q.parentQuestionId,
      depth: q.depth,
      orderIndex: q.orderIndex,
      category: q.category,
      mustPrepare: q.mustPrepare,
      followupBasis: q.followupBasis,
      questionText: q.questionText,
      suggestedAnswer: q.suggestedAnswer,
      materialGap: q.materialGap,
      sourceLogIds: Array.isArray(q.sourceLogIds) ? q.sourceLogIds : [],
      myMemo: q.myMemo,
      source: q.source ?? QUESTION_SOURCE_AI,
      lastPracticedAt: q.lastPracticedAt ?? null,
      lastPracticeResult: q.lastPracticeResult ?? null,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      children: [],
    };
  }
}
