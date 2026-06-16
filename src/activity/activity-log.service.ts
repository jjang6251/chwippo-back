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
import { CreateActivityLogDto } from './dto/create-activity-log.dto';
import { UpdateActivityLogDto } from './dto/update-activity-log.dto';
import { autoTag } from './auto-tagger';

@Injectable()
export class ActivityLogService {
  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
    private readonly dataSource: DataSource,
  ) {}

  async findAllForActivity(userId: string, activityId: string) {
    await this.assertActivityOwnership(userId, activityId);
    return this.logRepo.find({
      where: { activityId, userId },
      order: { occurredAt: 'DESC' },
    });
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
    return this.logRepo.save(log);
  }

  /** update 는 autoTag 재실행 안 함 — 사용자 명시 patch 만 적용 */
  async update(userId: string, logId: string, dto: UpdateActivityLogDto) {
    const log = await this.findEntity(userId, logId);
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
