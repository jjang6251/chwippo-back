import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { getKstWeekMonday, toKstDateString } from '../common/datetime';
import { Activity } from './entities/activity.entity';
import { ActivityReflection } from './entities/activity-reflection.entity';
import {
  CreateActivityReflectionDto,
  UpdateActivityReflectionDto,
} from './dto/reflection.dto';

/**
 * 이번 주 ISO 월요일 ('YYYY-MM-DD'). 항상 KST 기준.
 * memory `feedback_kst_local_date` — `toISOString().slice(0, 10)` 금지, 공용 datetime 모듈 사용.
 */
export function getISOWeekMonday(d: Date = new Date()): string {
  return getKstWeekMonday(toKstDateString(d));
}

@Injectable()
export class ActivityReflectionService {
  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityReflection)
    private readonly refRepo: Repository<ActivityReflection>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async findAllForActivity(userId: string, activityId: string) {
    await this.assertActivityOwnership(userId, activityId);
    return this.refRepo.find({
      where: { activityId, userId },
      order: { createdAt: 'DESC' },
    });
  }

  async create(
    userId: string,
    activityId: string,
    dto: CreateActivityReflectionDto,
  ) {
    await this.assertActivityOwnership(userId, activityId);
    const ref = this.refRepo.create({
      activityId,
      userId,
      content: dto.content,
      weekStart: dto.weekStart ?? getISOWeekMonday(),
      growth: dto.growth ?? [],
      challenges: dto.challenges ?? [],
      nextActions: dto.nextActions ?? [],
    });
    return this.refRepo.save(ref);
  }

  async update(
    userId: string,
    refId: string,
    dto: UpdateActivityReflectionDto,
  ) {
    const ref = await this.findEntity(userId, refId);
    if (dto.content !== undefined) ref.content = dto.content;
    if (dto.weekStart !== undefined) ref.weekStart = dto.weekStart;
    if (dto.growth !== undefined) ref.growth = dto.growth;
    if (dto.challenges !== undefined) ref.challenges = dto.challenges;
    if (dto.nextActions !== undefined) ref.nextActions = dto.nextActions;
    return this.refRepo.save(ref);
  }

  /**
   * Hard delete with source_refs guard (PR 1 신규).
   * coverletter_source_refs.source_reflection_id 참조가 있으면 409 — 자소서에서 먼저 제거.
   * (interview_source_refs 의 reflection 참조는 PR 2 에서 추가 시 동일 패턴으로 확장)
   */
  async remove(userId: string, refId: string) {
    const ref = await this.findEntity(userId, refId);
    const refCounts = await this.countReflectionRefs(ref.id);
    if (refCounts.total > 0) {
      throw new ConflictException(
        `이 회고는 자소서 ${refCounts.cover}건이 참조 중이에요. 자소서에서 먼저 제거해 주세요.`,
      );
    }
    await this.refRepo.remove(ref);
  }

  /** F6 source_refs 카운트 (reflection 기준). 테이블 없으면 0 */
  async countReflectionRefs(
    reflectionId: string,
  ): Promise<{ cover: number; total: number }> {
    const cover = (await this.tableExists('coverletter_source_refs'))
      ? await this.countRows(
          `SELECT COUNT(*) AS n FROM coverletter_source_refs WHERE source_reflection_id = $1`,
          [reflectionId],
        )
      : 0;
    return { cover, total: cover };
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

  private async findEntity(
    userId: string,
    refId: string,
  ): Promise<ActivityReflection> {
    const ref = await this.refRepo.findOne({ where: { id: refId, userId } });
    if (!ref) throw new NotFoundException('회고를 찾을 수 없습니다.');
    return ref;
  }

  private async assertActivityOwnership(userId: string, activityId: string) {
    const activity = await this.activityRepo.findOne({
      where: { id: activityId, userId },
    });
    if (!activity) throw new NotFoundException('활동을 찾을 수 없습니다.');
    return activity;
  }
}
