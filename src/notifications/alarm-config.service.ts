import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import {
  AlarmConfig,
  AlarmConfigUpdate,
  resolveAlarmConfig,
} from './notification.types';

/**
 * 알림 설정 — users.alarm_config + 권한 상태 컬럼 관리.
 * admin 통지는 config 밖 (opt-out 불가).
 */
@Injectable()
export class AlarmConfigService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** 사용자 alarm 설정 조회 (NULL → 기본값 merge) */
  async get(userId: string): Promise<AlarmConfig> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, alarmConfig: true },
    });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    return resolveAlarmConfig(user.alarmConfig);
  }

  /** 부분 update — 기존 설정과 merge 후 저장. 저장된 최종 설정 반환 */
  async update(
    userId: string,
    partial: AlarmConfigUpdate,
  ): Promise<AlarmConfig> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, alarmConfig: true },
    });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const current = resolveAlarmConfig(user.alarmConfig);
    // ⚠️ partial 은 ValidationPipe 가 만든 DTO "클래스 인스턴스" — 안 보낸 필드도
    // own property `undefined` 로 존재해서, 그대로 spread 하면 기존값을 undefined 로
    // 덮어쓰고 JSONB 저장에서 키가 탈락한다 (master 소실 실사고 2026-07-19).
    // undefined 필드를 제거한 뒤에만 merge 한다.
    const defined = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined),
    ) as AlarmConfigUpdate;
    const merged = resolveAlarmConfig({
      ...current,
      ...defined,
      // eventToggles 는 부분 update — 보낸 유형만 현재값에 깊게 merge (다른 유형 유지)
      eventToggles: defined.eventToggles
        ? {
            ...current.eventToggles,
            ...(Object.fromEntries(
              Object.entries(defined.eventToggles).filter(
                ([, v]) => v !== undefined,
              ),
            ) as Partial<typeof current.eventToggles>),
          }
        : current.eventToggles,
    });
    await this.userRepo.update({ id: userId }, { alarmConfig: merged });
    return merged;
  }

  /**
   * soft-ask 모달 응답 기록 — prompted_at = now + 권한 허용 여부.
   * 이후 다시 모달 안 뜸 (재요청 없음 정책).
   */
  async recordPrompt(userId: string, granted: boolean): Promise<void> {
    const result = await this.userRepo.update(
      { id: userId },
      {
        alarmPromptedAt: new Date(),
        alarmPermissionGranted: granted,
      },
    );
    if (!result.affected) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }
  }

  /**
   * OS 권한 상태 동기화 — 앱 시작 시 getPermissions 결과 반영.
   * 사용자가 iOS 설정에서 끈 경우 감지 (무의미 발송·통계 왜곡 방지).
   */
  async syncPermission(userId: string, granted: boolean): Promise<void> {
    await this.userRepo.update(
      { id: userId },
      { alarmPermissionGranted: granted },
    );
  }
}
