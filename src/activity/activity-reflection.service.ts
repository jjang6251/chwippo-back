import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async remove(userId: string, refId: string) {
    const ref = await this.findEntity(userId, refId);
    await this.refRepo.remove(ref);
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
