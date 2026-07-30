import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Notification } from './notification.entity';
import { NotificationLog } from './notification-log.entity';

/**
 * 알림 보관 기간 정리.
 *
 * 도입 배경 — 지금까지 **삭제 로직이 전혀 없어 알림이 영구 누적**됐다.
 * 브리핑만 해도 하루 1건이라 1년이면 수백 건이고, 그러면 목록을 훑는 것 자체가 불가능해진다
 * ("한눈에 안 들어온다"의 근본 원인 중 하나). 개인정보처리방침 §3 "목적 달성 시 지체 없이
 * 파기" 와도 어긋나 있었다.
 *
 * 보관 기간 (CEO 결정 2026-07-29):
 *   - 읽은 알림   7일   — 알림은 실시간성 정보라 일주일 지나면 가치가 급락. 지난 일정은 캘린더가 답한다
 *   - 안 읽은 알림 30일  — 놓친 것을 우리가 먼저 지우면 안 되므로 더 길게
 *   - 발송 로그   90일  — 사용자에게 안 보이지만 dedup 이 참조하므로 넉넉히
 *
 * ⚠️ **오늘 생성분은 절대 지우지 않는다** — `imminent` 중복 방지가
 * `notifications.payload.refId` 의 **오늘(KST)** 레코드를 조회하는 구조라
 * (`imminent.util.ts`), 오늘 것을 지우면 같은 알림이 15분 뒤 다시 발송된다.
 * 최소 임계가 7일이므로 현재 설정에서는 안전하지만, **7일 미만으로 낮추려면
 * 그 dedup 을 `notification_logs` 기준으로 먼저 옮겨야 한다.**
 */
export const RETENTION_DAYS = {
  read: 7,
  unread: 30,
  log: 90,
} as const;

/** 오늘 레코드 보호 — 이 값 미만으로는 어떤 임계도 내려갈 수 없다 (위 주석 참조) */
const MIN_SAFE_DAYS = 2;

@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationLog)
    private readonly logRepo: Repository<NotificationLog>,
  ) {}

  /** now 기준 daysAgo 일 전 시각 */
  private cutoff(now: Date, daysAgo: number): Date {
    return new Date(now.getTime() - daysAgo * 86_400_000);
  }

  async purge(now: Date = new Date()): Promise<{
    readDeleted: number;
    unreadDeleted: number;
    logDeleted: number;
  }> {
    // 설정 실수로 오늘 레코드가 지워지는 것을 코드 레벨에서 차단
    for (const [key, days] of Object.entries(RETENTION_DAYS)) {
      if (days < MIN_SAFE_DAYS) {
        throw new Error(
          `RETENTION_DAYS.${key}=${days} 는 최소 ${MIN_SAFE_DAYS}일 미만입니다. ` +
            'imminent dedup 이 오늘 레코드를 참조하므로 먼저 notification_logs 기준으로 옮기세요.',
        );
      }
    }

    /*
      DB 변경이 3개지만 **트랜잭션으로 묶지 않는다** (검토 결론, 2026-07-30 /qa).
      셋은 서로 불변식을 공유하지 않는다 — 2번이 실패해도 "일부만 정리됨" 이고
      다음 날 cron 이 이어서 지운다(멱등). 반대로 대량 DELETE 3개를 한 트랜잭션에 묶으면
      notifications 테이블 락을 그만큼 오래 쥐어 발송 쿼리를 막을 수 있다.
      묶는 쪽이 더 위험해서 안 묶은 것이다.
    */
    const readRes = await this.notificationRepo.delete({
      read: true,
      createdAt: LessThan(this.cutoff(now, RETENTION_DAYS.read)),
    });
    const unreadRes = await this.notificationRepo.delete({
      read: false,
      createdAt: LessThan(this.cutoff(now, RETENTION_DAYS.unread)),
    });
    // notification_logs 는 시각 컬럼명이 sent_at (발송 시각)
    const logRes = await this.logRepo.delete({
      sentAt: LessThan(this.cutoff(now, RETENTION_DAYS.log)),
    });

    const result = {
      readDeleted: readRes.affected ?? 0,
      unreadDeleted: unreadRes.affected ?? 0,
      logDeleted: logRes.affected ?? 0,
    };
    this.logger.log(
      `[NotificationRetention] 읽음 ${result.readDeleted} · 안읽음 ${result.unreadDeleted} · 로그 ${result.logDeleted} 삭제`,
    );
    return result;
  }
}
