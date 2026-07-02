import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserDevice } from './user-device.entity';
import { ApplicationStep } from '../applications/application-step.entity';

export interface PushCandidate {
  userId: string;
  deviceIds: string[];
  dueDate: Date;
  stepCount: number;
}

/**
 * W2 RN — Push 알림 후보 발굴 (실제 발송은 W3).
 *
 * 매일 09:00 KST 기준으로 D-3 · D-1 · D-0 범위에 걸린 스텝을 소유한 user +
 * 등록된 device 를 매핑. Cron 은 이 서비스만 호출.
 *
 * 실제 발송·중복 dedup 은 W3 push_jobs 테이블 통합 시 확장.
 */
@Injectable()
export class PushCandidateService {
  private readonly logger = new Logger(PushCandidateService.name);
  private static readonly DDAY_TARGETS = [0, 1, 3];

  constructor(
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
  ) {}

  /**
   * @param now 기준 시간 (테스트 편의 · 미지정 시 현재)
   */
  async findCandidates(now: Date = new Date()): Promise<PushCandidate[]> {
    const kstMidnight = this.getKstMidnight(now);
    const results: PushCandidate[] = [];

    for (const offsetDays of PushCandidateService.DDAY_TARGETS) {
      const target = new Date(kstMidnight);
      target.setUTCDate(target.getUTCDate() + offsetDays);
      const nextDay = new Date(target);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);

      // scheduled_date 범위 조회 + application 조인 (userId 필요)
      const steps = await this.stepRepo
        .createQueryBuilder('s')
        .innerJoinAndSelect('s.application', 'a')
        .where('s.scheduled_date >= :from AND s.scheduled_date < :to', {
          from: target,
          to: nextDay,
        })
        .getMany();

      const byUser = new Map<string, ApplicationStep[]>();
      for (const s of steps) {
        const uid = s.application?.userId;
        if (!uid) continue;
        const list = byUser.get(uid) ?? [];
        list.push(s);
        byUser.set(uid, list);
      }
      if (byUser.size === 0) continue;

      const devices = await this.deviceRepo.find({
        where: { userId: In(Array.from(byUser.keys())) },
      });
      const devicesByUser = new Map<string, string[]>();
      for (const d of devices) {
        const list = devicesByUser.get(d.userId) ?? [];
        list.push(d.id);
        devicesByUser.set(d.userId, list);
      }

      for (const [userId, userSteps] of byUser.entries()) {
        const deviceIds = devicesByUser.get(userId) ?? [];
        if (deviceIds.length === 0) continue;
        results.push({
          userId,
          deviceIds,
          dueDate: target,
          stepCount: userSteps.length,
        });
      }
    }

    this.logger.log(
      `[PushCandidateService] D-${PushCandidateService.DDAY_TARGETS.join('·D-')} 후보 ${results.length}건`,
    );
    return results;
  }

  /**
   * KST 자정 (UTC 15:00 전날) · Date 반환.
   * common/datetime 도 있지만 이 로직은 self-contained 로 유지.
   */
  private getKstMidnight(now: Date): Date {
    const kstOffsetMs = 9 * 60 * 60 * 1000;
    const kstDate = new Date(now.getTime() + kstOffsetMs);
    kstDate.setUTCHours(0, 0, 0, 0);
    return new Date(kstDate.getTime() - kstOffsetMs);
  }
}
