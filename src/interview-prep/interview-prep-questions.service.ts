import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

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
  questionText: string;
  suggestedAnswer: string | null;
  sourceLogIds: string[];
  myMemo: string | null;
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
      question_text: string;
      suggested_answer: string | null;
      source_log_ids: string[];
      my_memo: string | null;
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
             question_text, suggested_answer, source_log_ids, my_memo,
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
        questionText: r.question_text,
        suggestedAnswer: r.suggested_answer,
        sourceLogIds: Array.isArray(r.source_log_ids) ? r.source_log_ids : [],
        myMemo: r.my_memo,
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
   */
  async update(
    userId: string,
    questionId: string,
    dto: UpdateQuestionDto,
  ): Promise<QuestionNode> {
    const q = await this.findOwnedRaw(userId, questionId);
    if (dto.myMemo !== undefined) {
      const trimmed = (dto.myMemo ?? '').trim();
      q.myMemo = trimmed.length === 0 ? null : trimmed;
    }
    await this.questionRepo.save(q);
    return this.toNode(q);
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
    if (parent.depth >= 2) {
      throw new BadRequestException(
        '꼬리질문은 최대 2단계까지만 만들 수 있어요.',
      );
    }
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
      questionText: q.questionText,
      suggestedAnswer: q.suggestedAnswer,
      sourceLogIds: Array.isArray(q.sourceLogIds) ? q.sourceLogIds : [],
      myMemo: q.myMemo,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      children: [],
    };
  }
}
