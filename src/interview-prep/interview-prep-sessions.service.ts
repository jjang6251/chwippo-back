import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { assertJobTextPresent } from '../applications/job-text';

/**
 * `in_progress` **stale 보정** — 서버가 중간에 죽으면 상태가 그대로 남아 사용자가
 * 영원히 못 만든다. 생성은 ~10초라 **2분 초과면 죽은 것으로 보고 `idle` 로 내려**
 * 응답한다 (DB 는 건드리지 않는다 — 다음 생성의 atomic UPDATE 가 자연 회수한다).
 * 공고 파싱(`withJobPostingStatusGuard`)과 같은 방식이다.
 */
const GENERATION_STALE_MS = 2 * 60 * 1000;

function resolveGenerationStatus(
  s: InterviewPrepSession,
): 'idle' | 'in_progress' | 'completed' | 'failed' {
  const status = s.generationStatus ?? 'idle';
  if (status !== 'in_progress') return status;
  const started = s.generationStartedAt?.getTime();
  if (started === undefined || started < Date.now() - GENERATION_STALE_MS) {
    return 'idle';
  }
  return 'in_progress';
}

export interface SessionRefsExpanded {
  coverletters: Array<{
    id: string;
    category: string | null;
    question: string;
  }>;
  logs: Array<{
    id: string;
    activityName: string;
    occurredAt: string;
    content: string;
    cat: string | null;
  }>;
}

/**
 * F6 PR 2 Phase 2 — InterviewPrepSessionsService.
 *
 * **소유권 체인**: session → application → user (직접 user_id 도 보유, IDOR 가드용)
 *
 * **IDOR batch**:
 * - `coverletterIds[]` — 모두 본인 application 소속 cl 인지 (1 쿼리)
 * - `extraLogIds[]` — 모두 본인 activity_log 인지 (1 쿼리)
 * count mismatch 시 Forbidden (다른 사용자 ref 섞임 시도 차단)
 *
 * **응답 DTO user_id strip** (Q4 결정) — 본 service 의 모든 read 메서드가 `stripUserId()` 적용.
 * F6.5 익명화 풀 준비 — 응답에 user_id 노출 0건.
 */
export interface SessionResponse {
  id: string;
  applicationId: string;
  round: string;
  interviewType: string | null;
  coverletterIds: string[];
  extraLogIds: string[];
  myMemo: string | null;
  jobDescription: string | null;
  emphasisPoints: string | null;
  /**
   * 질문 생성 진행 상태 — 화면이 새로고침 후에도 "생성 중" 을 다시 보여주는 근거다.
   * 🔴 응답에 안 실으면 컬럼이 있어도 화면은 모른다 (`category` 가 그랬다).
   */
  generationStatus: 'idle' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class InterviewPrepSessionsService {
  constructor(
    @InjectRepository(InterviewPrepSession)
    private readonly sessionRepo: Repository<InterviewPrepSession>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
  ) {}

  // ── IDOR 가드 ──

  /** application 본인 소유 검증 — soft-deleted 제외. 정보 누출 방지 위해 NotFound */
  private async assertOwnsApplication(
    userId: string,
    applicationId: string,
  ): Promise<Application> {
    const app = await this.appRepo
      .createQueryBuilder('a')
      .where('a.id = :id', { id: applicationId })
      .andWhere('a.user_id = :userId', { userId })
      .andWhere('a.deleted_at IS NULL')
      .getOne();
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    return app;
  }

  /**
   * coverletter_ids[] IDOR batch — 모두 본인 application 의 cl 인지 한 쿼리로 확인.
   * count mismatch → Forbidden (선택한 cl 일부가 다른 사용자 소속이면 즉시 차단)
   */
  private async assertCoverlettersBelongToUser(
    userId: string,
    applicationId: string,
    coverletterIds: string[],
  ): Promise<void> {
    if (coverletterIds.length === 0) return;
    const count = await this.clRepo
      .createQueryBuilder('cl')
      .innerJoin('cl.application', 'app')
      .where('cl.id IN (:...ids)', { ids: coverletterIds })
      .andWhere('cl.application_id = :appId', { appId: applicationId })
      .andWhere('app.user_id = :userId', { userId })
      .getCount();
    if (count !== coverletterIds.length) {
      throw new ForbiddenException(
        '선택한 자소서 문항 중 본인 소유가 아닌 것이 있어요.',
      );
    }
  }

  /**
   * extra_log_ids[] IDOR batch — 모두 본인 activity_log 인지 한 쿼리.
   * count mismatch → Forbidden.
   */
  private async assertLogsBelongToUser(
    userId: string,
    logIds: string[],
  ): Promise<void> {
    if (logIds.length === 0) return;
    const count = await this.logRepo.count({
      where: { id: In(logIds), userId },
    });
    if (count !== logIds.length) {
      throw new ForbiddenException(
        '선택한 활동 로그 중 본인 소유가 아닌 것이 있어요.',
      );
    }
  }

  // ── CRUD ──

  async create(
    userId: string,
    dto: CreateSessionDto,
  ): Promise<SessionResponse> {
    const app = await this.assertOwnsApplication(userId, dto.applicationId);
    const coverletterIds = dto.coverletterIds ?? [];
    const extraLogIds = dto.extraLogIds ?? [];

    /**
     * v2 (2026-08-06, CEO 결정) — **자소서 없이는 세션을 못 만든다.**
     *
     * 이 기능의 값어치는 "내 자소서를 파고드는 질문" 이다. 자소서가 없으면 검색하면 나오는
     * 일반 면접 질문지가 되고, 그건 이 서비스를 쓸 이유가 못 된다. 동시에 자소서를 등록할
     * 이유를 만드는 장치이기도 하다 (PRD 의 "내 정보 창고를 채울 이유" 선순환).
     *
     * 🔴 **프론트 차단만으로는 부족하다** — devtools·직접 호출로 우회된다. 여기가 진짜 경계다.
     * 막는 지점을 "질문 생성" 이 아니라 **"세션 생성"** 으로 둔 이유: 질문 생성에서 막으면
     * 쓸 수 없는 빈 세션이 목록에 남아 막다른 길이 된다.
     */
    if (coverletterIds.length === 0) {
      throw new BadRequestException(
        '자소서를 1개 이상 선택해 주세요. 자소서를 바탕으로 예상 질문을 만듭니다.',
      );
    }

    /**
     * v2 (2026-08-06) — **직무 없이는 세션을 못 만든다.**
     *
     * 직무는 10개 fork 중 무엇을 물을지 정하는 기준이다 (개발=CS / 재무=재무제표 /
     * 연구=실험설계 …). 비어 있으면 fork 가 통째로 죽고 자소서 추궁만 남는다.
     * dev 실측: 카드 93장 중 16장이 직무 없이 남아 있었다 — 안내만 있고 그 자리에서
     * 고칠 수단이 없어서였다. 프론트가 모달 안에서 바로 고르게 바뀌었으므로 여기서 막는다.
     *
     * 🔴 판정 기준은 `resolveJobText` 와 **같아야 한다** — jobCategory 없어도 jobTitle 이
     * 있으면 fork 가 잡히므로 통과시킨다. 여기만 엄격하면 멀쩡한 카드가 막힌다.
     */
    assertJobTextPresent(app);
    await this.assertCoverlettersBelongToUser(
      userId,
      dto.applicationId,
      coverletterIds,
    );
    await this.assertLogsBelongToUser(userId, extraLogIds);

    const session = this.sessionRepo.create({
      userId,
      applicationId: dto.applicationId,
      round: dto.round,
      interviewType: dto.interviewType ?? null,
      coverletterIds,
      extraLogIds,
      myMemo: null,
      jobDescription: dto.jobDescription?.trim() || null,
      emphasisPoints: dto.emphasisPoints?.trim() || null,
    });
    const saved = await this.sessionRepo.save(session);
    return this.toResponse(saved);
  }

  /** 본인 application 의 모든 세션 (목록) */
  async listByApplication(
    userId: string,
    applicationId: string,
  ): Promise<SessionResponse[]> {
    await this.assertOwnsApplication(userId, applicationId);
    const rows = await this.sessionRepo.find({
      where: { applicationId, userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toResponse(r));
  }

  async findOne(userId: string, sessionId: string): Promise<SessionResponse> {
    const session = await this.findOwnedRaw(userId, sessionId);
    return this.toResponse(session);
  }

  /** 내부용 — entity raw (질문 서비스가 user_id 검증 후 사용) */
  async findOwnedRaw(
    userId: string,
    sessionId: string,
  ): Promise<InterviewPrepSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('면접 세션을 찾을 수 없습니다.');
    return session;
  }

  async update(
    userId: string,
    sessionId: string,
    dto: UpdateSessionDto,
  ): Promise<SessionResponse> {
    const session = await this.findOwnedRaw(userId, sessionId);
    if (dto.round !== undefined) session.round = dto.round;
    if (dto.interviewType !== undefined)
      session.interviewType = dto.interviewType;
    if (dto.myMemo !== undefined) session.myMemo = dto.myMemo;
    if (dto.jobDescription !== undefined)
      session.jobDescription =
        dto.jobDescription === null ? null : dto.jobDescription.trim() || null;
    if (dto.emphasisPoints !== undefined)
      session.emphasisPoints =
        dto.emphasisPoints === null ? null : dto.emphasisPoints.trim() || null;
    // Phase 4 — 자료 변경 (IDOR batch 재실행 필수)
    if (dto.coverletterIds !== undefined) {
      await this.assertCoverlettersBelongToUser(
        userId,
        session.applicationId,
        dto.coverletterIds,
      );
      session.coverletterIds = dto.coverletterIds;
    }
    if (dto.extraLogIds !== undefined) {
      await this.assertLogsBelongToUser(userId, dto.extraLogIds);
      session.extraLogIds = dto.extraLogIds;
    }
    const saved = await this.sessionRepo.save(session);
    return this.toResponse(saved);
  }

  async remove(userId: string, sessionId: string): Promise<void> {
    const session = await this.findOwnedRaw(userId, sessionId);
    await this.sessionRepo.remove(session);
  }

  /**
   * Phase 4 — 세션의 참고 자료 expand (title/카테고리 포함). 사이드바 메타카드 표시용.
   * IN 쿼리 2개 (coverletters + logs) 로 N+1 회피.
   * cross-user 격리 — coverletter 는 본인 application 만, log 는 본인 user 만.
   */
  async getRefs(
    userId: string,
    sessionId: string,
  ): Promise<SessionRefsExpanded> {
    const session = await this.findOwnedRaw(userId, sessionId);

    const coverletterIds = session.coverletterIds ?? [];
    const extraLogIds = session.extraLogIds ?? [];

    // coverletters — 본인 application 의 cl 만 (cl→app→user JOIN)
    const coverletters =
      coverletterIds.length === 0
        ? []
        : (
            await this.clRepo
              .createQueryBuilder('cl')
              .innerJoin('cl.application', 'app')
              .where('cl.id IN (:...ids)', { ids: coverletterIds })
              .andWhere('cl.application_id = :appId', {
                appId: session.applicationId,
              })
              .andWhere('app.user_id = :userId', { userId })
              .select(['cl.id', 'cl.category', 'cl.question'])
              .getMany()
          ).map((cl) => ({
            id: cl.id,
            category: cl.category,
            question: cl.question,
          }));

    // logs — 본인 user 의 log 만 + 활동 이름 join
    const logs =
      extraLogIds.length === 0
        ? []
        : (
            await this.logRepo
              .createQueryBuilder('l')
              .innerJoin('l.activity', 'a')
              .where('l.id IN (:...ids)', { ids: extraLogIds })
              .andWhere('l.user_id = :userId', { userId })
              .select(['l.id', 'l.content', 'l.cat', 'l.occurredAt', 'a.name'])
              .getMany()
          ).map((l) => ({
            id: l.id,
            activityName: (l as unknown as { activity: { name: string } })
              .activity.name,
            occurredAt: l.occurredAt,
            content: l.content,
            cat: l.cat,
          }));

    return { coverletters, logs };
  }

  /** 응답 mapper — user_id 제거 (Q4 defense in depth) */
  private toResponse(s: InterviewPrepSession): SessionResponse {
    return {
      id: s.id,
      applicationId: s.applicationId,
      round: s.round,
      interviewType: s.interviewType,
      coverletterIds: s.coverletterIds,
      extraLogIds: s.extraLogIds,
      myMemo: s.myMemo,
      jobDescription: s.jobDescription,
      emphasisPoints: s.emphasisPoints,
      generationStatus: resolveGenerationStatus(s),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
