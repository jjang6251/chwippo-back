import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Activity } from './entities/activity.entity';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';

export interface ListActivityOptions {
  includeArchived?: boolean;
}

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(Activity)
    private readonly repo: Repository<Activity>,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(userId: string, opts: ListActivityOptions = {}) {
    const where = opts.includeArchived
      ? { userId }
      : { userId, archivedAt: IsNull() };
    return this.repo.find({
      where,
      relations: ['logs', 'reflections'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string) {
    const activity = await this.repo.findOne({
      where: { id, userId },
      relations: ['logs', 'reflections'],
    });
    if (!activity) throw new NotFoundException('활동을 찾을 수 없습니다.');
    return activity;
  }

  private async findEntity(userId: string, id: string): Promise<Activity> {
    const activity = await this.repo.findOne({ where: { id, userId } });
    if (!activity) throw new NotFoundException('활동을 찾을 수 없습니다.');
    return activity;
  }

  async create(userId: string, dto: CreateActivityDto) {
    const entity = this.repo.create({
      userId,
      name: dto.name,
      type: dto.type,
      org: dto.org ?? null,
      role: dto.role ?? null,
      resultUrl: dto.resultUrl ?? null,
      outcome: dto.outcome ?? null,
      startedAt: dto.startedAt ?? null,
      endedAt: dto.endedAt ?? null,
    });
    return this.repo.save(entity);
  }

  async update(userId: string, id: string, dto: UpdateActivityDto) {
    const activity = await this.findEntity(userId, id);
    if (dto.name !== undefined) activity.name = dto.name;
    if (dto.type !== undefined) activity.type = dto.type;
    if (dto.org !== undefined) activity.org = dto.org;
    if (dto.role !== undefined) activity.role = dto.role;
    if (dto.resultUrl !== undefined) activity.resultUrl = dto.resultUrl;
    if (dto.outcome !== undefined) activity.outcome = dto.outcome;
    if (dto.startedAt !== undefined) activity.startedAt = dto.startedAt;
    if (dto.endedAt !== undefined) activity.endedAt = dto.endedAt;
    if (dto.summaryReflection !== undefined)
      activity.summaryReflection = dto.summaryReflection;
    await this.repo.save(activity);
    return this.findOne(userId, id);
  }

  async archive(userId: string, id: string) {
    const activity = await this.findEntity(userId, id);
    activity.archivedAt = new Date();
    return this.repo.save(activity);
  }

  async unarchive(userId: string, id: string) {
    const activity = await this.findEntity(userId, id);
    activity.archivedAt = null;
    return this.repo.save(activity);
  }

  /**
   * Hard delete with 2-tier source_refs guard.
   *  - 가드 1: F6 activity-level refs (interview_sessions.activity_ids 등)
   *  - 가드 2: 활동 소속 모든 log 의 log-level refs (coverletter/interview_source_refs)
   * F5 단계: 두 테이블 모두 없음 → 통과. F6 추가 시 자동 발동.
   * 통과 시 FK CASCADE 로 child logs/reflections 자동 삭제.
   */
  async remove(userId: string, id: string): Promise<void> {
    const activity = await this.findEntity(userId, id);

    const activityRefs = await this.countActivityRefs(activity.id);
    if (activityRefs > 0) {
      throw new ConflictException(
        '이 활동이 자소서·면접에 직접 참조 중이에요. 먼저 해당 자소서·면접 세션에서 정리하거나 활동을 보관함으로 이동하세요.',
      );
    }

    const logIds: string[] = await this.dataSource
      .createQueryBuilder()
      .select('l.id', 'id')
      .from('activity_logs', 'l')
      .where('l.activity_id = :id', { id: activity.id })
      .getRawMany()
      .then((rows: Array<{ id: string }>) => rows.map((r) => r.id));

    if (logIds.length > 0) {
      const logRefs = await this.countLogRefs(logIds);
      if (logRefs > 0) {
        throw new ConflictException(
          '이 활동의 기록 중 자소서·면접이 참조 중인 것이 있어요. 먼저 해당 자소서를 정리하거나 활동을 보관함으로 이동하세요.',
        );
      }
    }

    await this.repo.delete({ id: activity.id });
  }

  /** F6 interview_sessions 등 활동 단위 참조 카운트. 테이블 없으면 0 */
  private async countActivityRefs(activityId: string): Promise<number> {
    const exists = await this.tableExists('interview_sessions');
    if (!exists) return 0;
    const rows: Array<{ n: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS n FROM interview_sessions WHERE activity_ids @> $1::jsonb`,
      [JSON.stringify([activityId])],
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  /**
   * log 단위 source_refs 합산. 테이블 없으면 0.
   * - **자소서** (PR 1): `coverletter_source_refs.source_log_id = ANY($logIds)`
   * - **면접 세션 추가 로그** (PR 2): `interview_prep_sessions.extra_log_ids` JSONB `?|` (any of array)
   * - **면접 질문 답변 근거 로그** (PR 2): `interview_prep_questions.source_log_ids` JSONB `?|`
   */
  private async countLogRefs(logIds: string[]): Promise<number> {
    if (logIds.length === 0) return 0;
    let total = 0;
    if (await this.tableExists('coverletter_source_refs')) {
      const rows: Array<{ n: string }> = await this.dataSource.query(
        `SELECT COUNT(*) AS n FROM coverletter_source_refs WHERE source_log_id = ANY($1::uuid[])`,
        [logIds],
      );
      total += Number(rows?.[0]?.n ?? 0);
    }
    // jsonb ?| operator — array 의 어떤 element 가 logIds 중 하나라도 포함되면 match
    if (await this.tableExists('interview_prep_sessions')) {
      const rows: Array<{ n: string }> = await this.dataSource.query(
        `SELECT COUNT(*) AS n FROM interview_prep_sessions WHERE extra_log_ids ?| $1::text[]`,
        [logIds],
      );
      total += Number(rows?.[0]?.n ?? 0);
    }
    if (await this.tableExists('interview_prep_questions')) {
      const rows: Array<{ n: string }> = await this.dataSource.query(
        `SELECT COUNT(*) AS n FROM interview_prep_questions WHERE source_log_ids ?| $1::text[]`,
        [logIds],
      );
      total += Number(rows?.[0]?.n ?? 0);
    }
    return total;
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
