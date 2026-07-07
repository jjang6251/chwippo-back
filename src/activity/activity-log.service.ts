import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Activity } from './entities/activity.entity';
import { ActivityLog } from './entities/activity-log.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { StreakService } from '../dashboard/streak.service';
import { todayKst, toKstDateString } from '../common/datetime';
import { CreateActivityLogDto } from './dto/create-activity-log.dto';
import { QuickCreateActivityLogDto } from './dto/quick-create-activity-log.dto';
import { UpdateActivityLogDto } from './dto/update-activity-log.dto';
import { autoTag } from './auto-tagger';

@Injectable()
export class ActivityLogService {
  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    private readonly streakService: StreakService,
    private readonly dataSource: DataSource,
  ) {}

  async findAllForActivity(userId: string, activityId: string) {
    await this.assertActivityOwnership(userId, activityId);
    return this.logRepo.find({
      where: { activityId, userId },
      order: { occurredAt: 'DESC' },
    });
  }

  /**
   * activity-redesign — 유저별 숨김 "기본함" get-or-create.
   * 부분 unique 인덱스 (user_id WHERE is_inbox) 로 동시 생성 경합 방어 —
   * insert 충돌 시 재조회로 수렴.
   */
  async getOrCreateInbox(userId: string): Promise<Activity> {
    const found = await this.activityRepo.findOne({
      where: { userId, isInbox: true },
    });
    if (found) return found;
    try {
      return await this.activityRepo.save(
        this.activityRepo.create({
          userId,
          name: '기본함',
          type: 'other',
          isInbox: true,
        }),
      );
    } catch (err) {
      // 동시 요청이 먼저 만든 경우 (unique violation) → 재조회
      const again = await this.activityRepo.findOne({
        where: { userId, isInbox: true },
      });
      if (again) return again;
      throw err;
    }
  }

  /**
   * activity-redesign — 퀵캡처 생성.
   * - activityId 없으면 기본함 / isRest 는 같은 KST 날짜 멱등 + autoTag 미호출
   * - relatedStepId 는 본인 소유 스텝만 (일정 질문 답변 연결)
   */
  async quickCreate(userId: string, dto: QuickCreateActivityLogDto) {
    if (dto.isRest) {
      const today = todayKst();
      const existing = await this.logRepo.findOne({
        where: { userId, cat: 'rest', occurredAt: today },
      });
      if (existing) return existing; // 하루 1회 멱등
      const inbox = await this.getOrCreateInbox(userId);
      const restLog = await this.logRepo.save(
        this.logRepo.create({
          activityId: inbox.id,
          userId,
          content: dto.content?.trim() || '쉬어가는 날',
          occurredAt: today,
          cat: 'rest',
          comps: [],
          cl: [],
          keywords: [],
        }),
      );
      this.streakService.invalidateCache(userId);
      return restLog;
    }

    const content = dto.content?.trim();
    if (!content) {
      throw new BadRequestException('기록 내용을 입력해주세요.');
    }

    // relatedStepId — 본인 소유 스텝 검증 (IDOR)
    if (dto.relatedStepId) {
      const step = await this.stepRepo
        .createQueryBuilder('s')
        .innerJoin(
          'applications',
          'a',
          'a.id = s.application_id AND a.user_id = :userId AND a.deleted_at IS NULL',
          { userId },
        )
        .where('s.id = :stepId', { stepId: dto.relatedStepId })
        .getOne();
      if (!step) {
        throw new NotFoundException('일정을 찾을 수 없습니다.');
      }
    }

    const activity = dto.activityId
      ? await this.assertActivityOwnership(userId, dto.activityId)
      : await this.getOrCreateInbox(userId);
    if (activity.archivedAt) {
      throw new BadRequestException(
        '아카이브된 활동에는 로그를 추가할 수 없습니다.',
      );
    }

    const auto = autoTag(content, activity.type);
    const saved = await this.logRepo.save(
      this.logRepo.create({
        activityId: activity.id,
        userId,
        content,
        occurredAt: dto.occurredAt ?? todayKst(),
        relatedStepId: dto.relatedStepId ?? null,
        cat: auto.cat,
        comps: auto.comps,
        cl: auto.cl,
        quant: auto.quant,
        mood: null,
        keywords: auto.keywords,
        note: null,
      }),
    );
    this.streakService.invalidateCache(userId);
    return saved;
  }

  /**
   * activity-redesign — 유저 전체 타임라인 (occurred_at DESC · created_at DESC).
   * keyset cursor: "occurredAt|createdAtISO". archived 제외.
   * 활동명·is_inbox + related step 의 회사·스텝명 join.
   */
  async timeline(userId: string, cursor?: string, limit = 30) {
    const qb = this.logRepo
      .createQueryBuilder('log')
      .innerJoin('log.activity', 'act')
      .leftJoin('application_steps', 's', 's.id = log.related_step_id')
      .leftJoin('applications', 'app', 'app.id = s.application_id')
      .select([
        'log.id AS id',
        'log.content AS content',
        'log.occurred_at AS occurred_at',
        'log.cat AS cat',
        'log.cl AS cl',
        'log.comps AS comps',
        'log.mood AS mood',
        'log.quant AS quant',
        'log.keywords AS keywords',
        'log.note AS note',
        'log.created_at AS created_at',
        'log.activity_id AS activity_id',
        'act.name AS activity_name',
        'act.is_inbox AS activity_is_inbox',
        's.id AS related_step_id',
        's.name AS step_name',
        'app.company_name AS company_name',
      ])
      .where('log.user_id = :userId', { userId })
      .andWhere('log.archived_at IS NULL')
      .orderBy('log.occurred_at', 'DESC')
      .addOrderBy('log.created_at', 'DESC')
      .limit(limit + 1);

    if (cursor) {
      const [occurredAt, createdAtIso] = cursor.split('|');
      if (
        !occurredAt ||
        !createdAtIso ||
        isNaN(Date.parse(occurredAt)) || // 날짜 파트 미검증 시 ::date 캐스트가 DB 에러(500)
        isNaN(Date.parse(createdAtIso))
      ) {
        throw new BadRequestException('잘못된 cursor 입니다.');
      }
      qb.andWhere(
        '(log.occurred_at, log.created_at) < (:cursorOccurred::date, :cursorCreated::timestamptz)',
        { cursorOccurred: occurredAt, cursorCreated: createdAtIso },
      );
    }

    const rows = await qb.getRawMany<{
      id: string;
      content: string;
      occurred_at: string;
      cat: string | null;
      cl: unknown;
      comps: unknown;
      mood: string | null;
      quant: unknown;
      keywords: unknown;
      note: unknown;
      created_at: Date;
      activity_id: string;
      activity_name: string;
      activity_is_inbox: boolean;
      related_step_id: string | null;
      step_name: string | null;
      company_name: string | null;
    }>();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        content: r.content,
        occurredAt:
          typeof r.occurred_at === 'string'
            ? r.occurred_at
            : toKstDateString(new Date(r.occurred_at)),
        cat: r.cat,
        cl: r.cl ?? [],
        comps: r.comps ?? [],
        mood: r.mood,
        quant: r.quant ?? null,
        keywords: r.keywords ?? [],
        hasNote: r.note != null,
        createdAt: r.created_at,
        activityId: r.activity_id,
        activityName: r.activity_name,
        activityIsInbox: r.activity_is_inbox,
        relatedStepId: r.related_step_id,
        stepName: r.step_name,
        companyName: r.company_name,
      })),
      nextCursor:
        hasMore && last
          ? `${typeof last.occurred_at === 'string' ? last.occurred_at : toKstDateString(new Date(last.occurred_at))}|${new Date(last.created_at).toISOString()}`
          : null,
    };
  }

  async create(userId: string, activityId: string, dto: CreateActivityLogDto) {
    const activity = await this.assertActivityOwnership(userId, activityId);
    if (activity.archivedAt) {
      throw new BadRequestException(
        '아카이브된 활동에는 로그를 추가할 수 없습니다.',
      );
    }
    const auto = autoTag(dto.content ?? '', activity.type);
    // undefined → autoTag fallback. [] 또는 명시값 → 그대로 (사용자 의도)
    const log = this.logRepo.create({
      activityId,
      userId,
      content: dto.content,
      occurredAt: dto.occurredAt,
      cat: dto.cat !== undefined ? dto.cat : auto.cat,
      comps: dto.comps !== undefined ? dto.comps : auto.comps,
      cl: dto.cl !== undefined ? dto.cl : auto.cl,
      quant: dto.quant !== undefined ? (dto.quant ?? null) : auto.quant,
      mood: dto.mood ?? null,
      keywords: dto.keywords !== undefined ? dto.keywords : auto.keywords,
      note: dto.note ?? null,
    });
    const saved = await this.logRepo.save(log);
    this.streakService.invalidateCache(userId);
    return saved;
  }

  /** update 는 autoTag 재실행 안 함 — 사용자 명시 patch 만 적용 */
  async update(userId: string, logId: string, dto: UpdateActivityLogDto) {
    const log = await this.findEntity(userId, logId);
    // activity-redesign — 로그의 활동 이동 (기본함 → 활동 등). 본인 활동만
    if (dto.activityId !== undefined && dto.activityId !== log.activityId) {
      const target = await this.assertActivityOwnership(userId, dto.activityId);
      if (target.archivedAt) {
        throw new BadRequestException(
          '아카이브된 활동으로는 이동할 수 없습니다.',
        );
      }
      log.activityId = target.id;
    }
    if (dto.content !== undefined) log.content = dto.content;
    if (dto.occurredAt !== undefined) log.occurredAt = dto.occurredAt;
    if (dto.cat !== undefined) log.cat = dto.cat;
    if (dto.mood !== undefined) log.mood = dto.mood;
    if (dto.comps !== undefined) log.comps = dto.comps;
    if (dto.cl !== undefined) log.cl = dto.cl;
    if (dto.quant !== undefined) {
      log.quant = dto.quant ?? null;
    }
    if (dto.keywords !== undefined) log.keywords = dto.keywords;
    if (dto.note !== undefined) log.note = dto.note;
    return this.logRepo.save(log);
  }

  async archiveLog(userId: string, logId: string) {
    const log = await this.findEntity(userId, logId);
    log.archivedAt = new Date();
    return this.logRepo.save(log);
  }

  async unarchiveLog(userId: string, logId: string) {
    const log = await this.findEntity(userId, logId);
    log.archivedAt = null;
    return this.logRepo.save(log);
  }

  /**
   * Hard delete with source_refs guard.
   * F5 단계: source_refs 테이블 없음 → 통과. F6 추가 시 자동 발동.
   */
  async remove(userId: string, logId: string): Promise<void> {
    const log = await this.findEntity(userId, logId);
    const refCounts = await this.countLogRefs(log.id);
    if (refCounts.total > 0) {
      throw new ConflictException(
        `이 기록은 자소서 ${refCounts.cover}건·면접 세션 ${refCounts.interviewSessions}개·면접 질문 ${refCounts.interviewQuestions}개가 참조 중이에요. 자소서·면접에서 먼저 제거하거나 보관함으로 이동하세요.`,
      );
    }
    await this.logRepo.delete({ id: log.id });
    this.streakService.invalidateCache(userId);
  }

  private async findEntity(
    userId: string,
    logId: string,
  ): Promise<ActivityLog> {
    const log = await this.logRepo.findOne({
      where: { id: logId, userId },
    });
    if (!log) throw new NotFoundException('로그를 찾을 수 없습니다.');
    return log;
  }

  private async assertActivityOwnership(
    userId: string,
    activityId: string,
  ): Promise<Activity> {
    const activity = await this.activityRepo.findOne({
      where: { id: activityId, userId },
    });
    if (!activity) throw new NotFoundException('활동을 찾을 수 없습니다.');
    return activity;
  }

  /**
   * F6 source_refs 카운트. 테이블 없으면 0.
   * - **자소서** (PR 1): `coverletter_source_refs.source_log_id`
   * - **면접 세션 추가 로그** (PR 2): `interview_prep_sessions.extra_log_ids` JSONB `@>`
   * - **면접 질문 답변 근거 로그** (PR 2): `interview_prep_questions.source_log_ids` JSONB `@>`
   *
   * 각 테이블 GIN 인덱스로 ≤10ms (PR 2 마이그레이션 idx_ips_extra_log_ids_gin · idx_ipq_source_log_ids_gin).
   */
  async countLogRefs(logId: string): Promise<{
    cover: number;
    interviewSessions: number;
    interviewQuestions: number;
    interview: number;
    total: number;
  }> {
    const cover = (await this.tableExists('coverletter_source_refs'))
      ? await this.countRows(
          `SELECT COUNT(*) AS n FROM coverletter_source_refs WHERE source_log_id = $1`,
          [logId],
        )
      : 0;
    const jsonbArg = JSON.stringify([logId]);
    const interviewSessions = (await this.tableExists(
      'interview_prep_sessions',
    ))
      ? await this.countRows(
          `SELECT COUNT(*) AS n FROM interview_prep_sessions WHERE extra_log_ids @> $1::jsonb`,
          [jsonbArg],
        )
      : 0;
    const interviewQuestions = (await this.tableExists(
      'interview_prep_questions',
    ))
      ? await this.countRows(
          `SELECT COUNT(*) AS n FROM interview_prep_questions WHERE source_log_ids @> $1::jsonb`,
          [jsonbArg],
        )
      : 0;
    const interview = interviewSessions + interviewQuestions;
    return {
      cover,
      interviewSessions,
      interviewQuestions,
      interview,
      total: cover + interview,
    };
  }

  private async countRows(sql: string, params: unknown[]): Promise<number> {
    const rows: Array<{ n: string }> = await this.dataSource.query(sql, params);
    return Number(rows?.[0]?.n ?? 0);
  }

  private async tableExists(name: string): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [name],
    );
    return Boolean(rows?.[0]?.exists);
  }
}
